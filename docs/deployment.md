# Deployment — LaunchAgent, BTM denial, log discipline

Full forensic story behind why sideclaw runs the way it does. CLAUDE.md and
`.claude/rules/deployment.md` keep only the invariants (never start standalone,
use the tracked plist, logs live in `~/Library/Logs`); this is the "why", read
on demand before touching `com.jkrumm.sideclaw-server.plist` or
`scripts/sideclaw-start.sh` — the same story is also inline as comments in
both those files, since an editor there may never open this doc.

## Logs must live in `~/Library/Logs`, never `/tmp`

A KeepAlive agent opens its stdio exactly once, at spawn. macOS's periodic
cleanup sweeps `/tmp` files untouched for 3+ days, so after a sweep the
process keeps writing into an unlinked inode: `lsof` still shows the fd, `ls`
says the file is gone, and every line written since is unrecoverable — which
is how sideclaw ended up with no post-mortem at all (measured on this machine
2026-07-31: `lsof -p 895` showed `/private/tmp/sideclaw.log` and `.err` held
open while `ls /tmp/sideclaw.log` returned "No such file"). The paths live in
`com.jkrumm.sideclaw-server.plist`, and `make install-agent` copies that file
verbatim over the live one, so changing the live plist by hand is silently
reverted on the next install. Change the tracked file.

## Drain window sizing — why `SHUTDOWN_GRACE_MS` is 40 min, not a measured percentile

Measured 2026-09-08 over 91 real jobs from three days of `~/Library/Logs/sideclaw.jsonl`
(`job.start` joined to `job.done`/`job.fail` by `jobId`, duration = `finished_at - started_at`):

| Tool | n | p50 | p95 | max |
|-|-|-|-|-|
| overview | 50 | 100 s | 242 s | 482 s |
| narrative | 18 | 49 s | 73 s | 73 s |
| check | 12 | 78 s | 166 s | 166 s |
| review | 9 | 345 s | 685 s | 685 s |
| dispatch | 2 | 98 s | — | 98 s |
| all | 91 | 78 s | 421 s | 685 s |

96% of all 91 jobs ran longer than the old `SHUTDOWN_GRACE_MS` (20 s, `server/index.ts`) — the
drain had never once carried a real job to completion; SIGTERM always fell through to "grace
period over, exiting with jobs still running".

`SHUTDOWN_GRACE_MS` is deliberately **not** read off this table — `review`'s n=9 is too thin to
size a deadline from, and treating a single observed max as a safe ceiling is precisely the
estimation error a drain window exists to guard against. It's built from `dispatch`'s
`implement` tier instead (`TIERS.implement.timeoutMs`, `server/jobs/handlers/dispatch.ts`,
30 min) — the longest job timeout actually *configured* in code, and the only tool with real
work to do after its worker session returns.

### The math this section used to get wrong

An earlier version of this file (and the comment in `shutdown.ts`) sized the window on "a job
can legitimately run up to its own configured timeout, and never longer." That was false. A
follow-up revision fixed the timeout math but still undercounted: it treated the only
double-`timeoutMs` chain as the rare `max`→`iu` provider-retry fallback inside
`runSession()`, and concluded the window's true worst case was "60 minutes, reachable only when
a provider-side retry signal happens to fire mid-hang." That is a real chain, but it is not the
only one, and it is not the one most likely to fire — `dispatch.ts`'s own handler-level salvage
retry is a SEPARATE mechanism that reaches the same 60-minute figure through the *ordinary*
path, no timeout or provider signal required at all:

- `isSalvageable()` (`server/jobs/handlers/dispatch.ts`) fires on a `max_turns` error or a
  schema/parse failure — hitting the turn budget without emitting valid JSON, or emitting JSON
  that doesn't validate. That is a routine way for a session to end badly, not an edge case.
- The retry it triggers is a FRESH `runSession()` call with a smaller turn budget
  (`retryTurns`) but the SAME `timeoutMs` ceiling as the first attempt (`profile.timeoutMs`,
  unchanged between the two `runEpisode()` calls in `runDispatch()`). So the reachable chain
  through this path alone is two full `timeoutMs` windows — 2 × 30 min = 60 min of session
  wall-clock — on any `implement` episode that simply runs long and fumbles its JSON.

The two chains do not compound past 60 minutes for a single `runEpisode()` call:
`isSalvageable()` explicitly excludes a timeout (`noOutput` is never set on that return path,
and the error text matches neither `max_structured_output_retries` nor `max_turns`), so a hang
that exhausts the internal `max`→`iu` fallback throws straight to the job failure with no
further dispatch.ts retry stacked on top. But that bounds only the fallback chain — it does not
make the salvage-retry chain any rarer, and that one needs neither a timeout nor a provider
signal to reach.

So the reachable worst case, from either chain (most plausibly the ordinary salvage retry) plus
`depositBranch()`'s own bounded git/PR work after a successful session, is **~70 minutes**, not
the 60 the prior revision of this doc claimed and not the 40 this window actually covers.
Covering that reachable 70-minute chain would put `make reload`'s worst case past an hour. That
is not sizing conservatively — it is a window nobody would actually wait out, which defeats the
window's purpose as much as the original wrong math did — so this file makes a deliberate,
documented trade instead of chasing either chain:

- **30 min base** — a single `implement` attempt's own configured `timeoutMs`, the dominant
  case (no retry triggered — the common outcome is still a session that finishes or fails
  outright inside its own budget).
- **+10 min teardown margin** — `depositBranch()`'s fully bounded worst case, computed from its
  actual per-call timeouts (`server/jobs/handlers/dispatch-git.ts`), not guessed:

  | Step | Calls | Timeout each |
  |-|-|-|
  | `commitPendingWork` (add, diff --cached, commit) | 3 | 60 s |
  | `commitCount` (rev-list) | 1 | 60 s |
  | `summarizeDiff` (diff --numstat) | 1 | 60 s |
  | `diffRefusalReason` → `addedSecrets` (diff -U0) | 1 | 60 s |
  | `pushBranch` (rev-parse + push) | 2 | 60 s / 180 s |

  Sum: 600 s = 10 min, if every one of those subprocess calls independently hung to its own
  ceiling — a real code-level bound, not a percentile. (`openPullRequest`'s Octokit call carries
  no timeout of its own and is not folded into this figure; a genuine network hang there is a
  different failure class than "legitimate slow work".)

That 40 minutes covers the dominant single-attempt path in full. Neither the ordinary
salvage-retry chain nor the rarer double-timeout `max`→`iu` fallback chain (~60-70 min combined
with teardown, either way) is covered — including the salvage-retry one, which is reachable on
any `implement` episode that fumbles its JSON, no timeout or provider signal needed. A job
caught by either is killed at the grace deadline like any other still-running job, and (see
`execute()` in `server/jobs/store.ts`) is left `running` rather than written `failed`, so the
next boot's ordinary crash-recovery reconciles it exactly like a crash. `dispatch` is
deliberately absent from `REQUEUE_ON_RECOVER` (an `implement` episode may already have pushed a
branch or opened a PR before the kill), so it lands on `interrupted`, not a silent automatic
re-run — never silently discarded, never misreported as a real failure on
`GET /api/jobs/health`, and never doubled against a repo the first episode may have already
changed. Doubling every reload's worst-case wait to cover a chain this ordinarily reachable is a
worse trade than that.

**Four numbers move together** — raising the base or the margin means updating all of them, or
the ones left behind become the new bottleneck:

| Constant | Where | Value | Role |
|-|-|-|-|
| `SHUTDOWN_GRACE_MS` | `server/lib/shutdown.ts` | 40 min (2400 s) | app-level drain deadline |
| `SHUTDOWN_FLUSH_MS` | `server/lib/shutdown.ts` | 3 s | HTTP response flush after the drain decision |
| `ExitTimeOut` | `com.jkrumm.sideclaw-server.plist` | 45 min (2700 s) | launchd's own hard kill — must exceed GRACE+FLUSH (2403 s) with real margin, or launchd SIGKILLs mid-drain regardless of what the app-level timer intends |
| poll ceiling | `Makefile`'s `reload` target | 46 min (5520 half-second ticks / 2760 s) | how long `make reload` waits for the old PID to exit before `kickstart`ing — must exceed `ExitTimeOut`, the true worst case, or the kickstart can land on a process launchd hasn't force-killed yet |

Two guards pin this in `bun test` rather than at the next reboot:
`tests/deployment-plist.test.ts` (`ExitTimeOut > SHUTDOWN_GRACE_MS + SHUTDOWN_FLUSH_MS`) and
`tests/shutdown-dispatch-coupling.test.ts` (the 30-min base literal in `shutdown.ts` still
matches `TIERS.implement.timeoutMs` in `dispatch.ts` — the two are independent literals on
purpose, kept in step by a test rather than a runtime import, so `shutdown.ts` stays free of
`dispatch.ts`'s import graph).

### A plist edit needs `make install-agent`, not `make reload`

`launchctl kill` (what `make reload` uses to signal the running process) operates on the job
definition launchd already has **loaded in memory** — it does not re-read
`com.jkrumm.sideclaw-server.plist` from disk. Only `launchctl bootstrap` (`make install-agent`)
loads a changed plist. Measured live on this machine (2026-09-08): after raising the tracked
plist's `ExitTimeOut` from 20 (launchd's implicit default) to 1860, `launchctl print
gui/$(id -u)/com.jkrumm.sideclaw-server` kept reporting `exit timeout = 5` — a value from a
plist generation *before* the 1860 edit — because no `make install-agent` had run yet. Running
`make reload` in that window would have raised `SHUTDOWN_GRACE_MS` to double digits of minutes
in-process while launchd's own timer stayed at 5 seconds underneath it: the app would start a
long drain, and launchd would SIGKILL it 5 seconds in regardless, silently discarding the drain
change entirely.

That measurement was `install-agent` simply never having been run yet. A second, subtler way to
reach the same broken state is `install-agent` failing PARTWAY through: `cp` runs before
`launchctl bootstrap`, and `bootstrap` errors ("service already bootstrapped") against a label
that's already loaded — the normal case, since this service is meant to stay loaded across
restarts. Before this was fixed, that meant a completely ordinary re-run of `make install-agent`
(bumping `ExitTimeOut` again, say) would copy the new plist over the old one and then fail to
load it — the FILE compare `make reload` used to rely on exclusively cannot see this at all,
because by the time `reload` runs, the installed FILE already matches the tracked one; only
launchd's in-memory definition is still stale. `install-agent` now boots the current label out
before re-bootstrapping it (never suppressing a genuine `bootstrap` failure after that — a
`|| true` there would recreate exactly this bug), and `make reload`'s drift guard now ALSO
compares launchd's live `exit timeout` value (`launchctl print` reports it directly) against the
tracked plist, not just the two files, so this class of drift is caught even if it happens again
through some other path.

### `install-agent` waits for the old process, and fails loudly if the new one never comes up

`launchctl bootout` (what `install-agent` used to rely on alone to clear the old job definition
before re-bootstrapping) is a REQUEST, not a guaranteed-blocking wait for the process to
actually exit. If a job is running when someone runs `make install-agent`, the old process can
still be mid-drain — holding `:7705` for up to `SHUTDOWN_GRACE_MS` — while `cp` + `bootstrap`
immediately follow and spawn a NEW instance via `RunAtLoad`. That new instance's own
`app.listen()` fails to bind the still-held port and it crash-loops, while `install-agent`
reported success regardless: none of `bootout`/`cp`/`bootstrap` fail merely because a DIFFERENT
process couldn't bind a port, and the target's last line was an unconditional `echo`.

`install-agent` now carries the same PID-capture-and-poll `reload` already had (same ceiling —
5520 half-second ticks, pinned against both `reload`'s own loop and `ExitTimeOut` by
`tests/makefile-poll-ceiling.test.ts`) between the `bootout` and the `cp`/`bootstrap` that
follow, and the same job-in-flight guard `reload` has (refuses by default while a job is
running; `FORCE=1` sends SIGINT — the catchable forced-abort signal, never SIGKILL, for the same
reason `reload`'s `FORCE=1` does — before `bootout`, then proceeds without waiting). The target
now also polls the new instance's `/health` after `bootstrap` and exits non-zero with a pointer
to the log if it never comes up, instead of the previous unconditional "installed and started."

### FORCE=1 sends SIGINT, never SIGKILL

`FORCE=1 make reload` exists to discard in-flight jobs rather than wait out a 40 min drain.
Discarding jobs does not require an unabortable process kill: SIGKILL is not catchable, so it
would skip `server/lib/shutdown.ts`'s `createShutdownController` handler entirely, and with it
`terminateActiveSessions()` — the `claude -p` worker subprocesses have no process group
detachment and no parent-death signal, so they'd survive as orphans that keep
writing/committing in their worktree (and, for an `implement` dispatch, could still push a
branch or open a PR) after the reload believed it had stopped them. `FORCE=1` sends SIGINT
instead, which hits the *same* handler with a zero-length grace period: draining is skipped
(that's the whole point of FORCE) but every worker is still terminated before the process exits.
A SIGINT that arrives while a SIGTERM drain is already running (an operator watching a normal
`make reload` escalate with `FORCE=1 make reload` against the same still-draining process)
escalates that drain to an immediate abort instead of being dropped by an already-shutting-down
latch — every worker is still terminated exactly once. A killed `implement` dispatch's worktree
is bundled to `~/.local/state/sideclaw/salvage/` by the boot sweep before removal, same as a
real crash, and its job row is left `running` for the same boot's ordinary crash-recovery to
reconcile (see `execute()` in `server/jobs/store.ts`) rather than written `failed` — the whole
point being that a shutdown-killed job reads identically to a crashed one, everywhere.

### `draining` and boot grace in `GET /api/jobs/health`

`promote()` refuses every `pending → running` transition while a drain is in progress
(`setDraining()`, called from the SIGTERM/SIGINT handler) — a job promoted into the grace
window's dying process would just be interrupted and burn its one re-queue for nothing. That
means submissions genuinely back up during a reload, and with a 40 min window
`oldestPendingAgeMs` can comfortably exceed the health check's 15 min "wedged queue" threshold
on a perfectly normal reload. `evaluateJobHealth()` takes `draining` as an input and skips the
`oldestPendingAgeMs` criterion (only that one — `failedLastHour` still trips `ok: false`
regardless) while it's true, and `GET /api/jobs/health` surfaces `draining: true` directly in
its response so devhost-health (or any other consumer) can tell "a reload is in flight" apart
from "the queue is actually wedged" without guessing from the pending count alone.

The same false alarm has a smaller sibling on the OTHER side of a restart: `draining` itself is
module-scope state, so it always resets to `false` the moment the fresh process boots — even
though the backlog of `pending` rows it left behind (their `created_at` predating the restart by
up to the prior drain window) is still there. `evaluateJobHealth()` also grants the same
`oldestPendingAgeMs` exemption for `BOOT_HEALTH_GRACE_MS` (5 min) after this process started —
long enough for the `MAX_CONCURRENT`-wide queue to work through a typical post-restart backlog —
so the first few minutes after an ordinary reload don't page for a queue that is draining
normally, just from an old baseline.

That grace is deliberately NOT unconditional on `sinceBootMs` alone — an earlier version of this
mechanism was, and it was a bug: a process that crash-loops faster than `BOOT_HEALTH_GRACE_MS`
can ever expire (SIGKILL, OOM, an unhandled fault before the shutdown handler even runs) always
looks freshly booted, so a REAL, growing `pending` backlog stayed permanently invisible behind
"just restarted, give it a minute" — masking exactly the failure mode this route exists to
surface. The grace is instead gated on `recoveredFromDrain`
(`server/jobs/store.ts`): `markDrainCompleted()` writes a one-row, self-clearing marker
(`drain_completed.drained_at`) when the shutdown path reaches its **end** — from
`server/lib/shutdown.ts`'s `finish()`, not from `setDraining()`. Writing it at the *start* of a
drain was the first attempt and was wrong: that marker also survives a SIGKILL, an OOM or a hang
mid-drain, so the next boot would hand the grace to exactly the crash loop the grace exists to
expose. Reaching `finish()` is the narrowest available proof that the exit was orderly, and it
still covers a grace-expiry exit, which is orderly too. The NEXT process to boot reads
and deletes that row once; its presence means "the previous process reached an orderly drain
before it died," its absence means "it didn't" — a crash never writes it, so a crash-looping
process gets `recoveredFromDrain: false` on every single restart and the backlog alarm fires
immediately instead of being re-exempted forever. `evaluateJobHealth()`'s `sinceBootMs` grace
only applies when `recoveredFromDrain` is also true.

## The BTM denial — why the label and the wrapper script are load-bearing

The label is `com.jkrumm.sideclaw-server` and the program is a wrapper script
— both are Background Task Management workarounds, not style. macOS computes
an *effective* disposition for every launch item, and on this host two
separate denials applied: `/opt/homebrew/bin/bun` as an executable, and the
identifier `8.com.jkrumm.sideclaw`. Either one alone is enough to make
launchd skip the `RunAtLoad` spawn — which is what "sideclaw doesn't come up
after a power cut" actually was, reproduced across three reboots on
2026-08-06 (one no-start, two starting ~3 minutes late, against ~18s for
every allowed agent on the machine).

Measured, not inferred: a throwaway agent running only `bun --version` under
a never-seen label registered `[enabled, allowed]` and BTM immediately
resolved it to `[enabled, disallowed]`; the same probe through a shell script
resolved to `[enabled, allowed]`. The identifier half is stickier than it
looks — deleting the plist, re-adding it, and re-adding it under a different
*filename* all came back disallowed, so only a new **Label** clears it. Hence
`scripts/sideclaw-start.sh` (dodges the bun denial) plus the `-server` label
(dodges the identifier denial). Reverting either brings the boot failure
back. It also makes the entry legible as `sideclaw-start.sh` rather than an
anonymous `bun` in System Settings → Login Items, which is how it plausibly
got denied in the first place.

Verify after any change to the plist:

```bash
log show --last 2m --info | grep -A3 sideclaw-server.plist | grep effectiveItemDisposition
# want: result=[enabled, allowed, ...]
```
