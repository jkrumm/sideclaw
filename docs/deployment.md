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

## Two shutdown paths, two windows — and why an earlier version of this section was wrong

An earlier revision of this file (and of `server/lib/shutdown.ts`'s comments) sized ONE drain
window, `SHUTDOWN_GRACE_MS`, and applied it uniformly to every shutdown trigger — SIGTERM from
`make reload`, SIGINT from `FORCE=1`, a real reboot, all of it. **That was wrong.** Measured on
this host 2026-09-08: raising the tracked plist's `ExitTimeOut` to 2700 (45 min) changed
nothing — `launchctl print gui/<uid>/com.jkrumm.sideclaw-server` still reported `exit timeout =
60`, and a control probe at 120 confirmed the same 60s ceiling. launchd hard-caps `ExitTimeOut`
at 60 seconds on this machine, full stop, regardless of what the plist says. Every `make reload`
that ran under the old code was never actually protected by the 40-minute drain it believed it
had — a real SIGTERM was SIGKILLed around the 60s mark the entire time, mid-`review` or
mid-`dispatch implement`, exactly the failure this mechanism exists to prevent. The drift guard
below (comparing the tracked plist against launchd's own live value) is what surfaced this: it
was built to catch a stale ExitTimeOut, and in the course of verifying it, surfaced that even a
*correctly loaded* ExitTimeOut is capped by launchd itself.

The fix is not a bigger number — no plist value raises that cap — it's changing which trigger
governs which window:

- **HTTP-initiated** (`POST /api/shutdown`, `server/routes/shutdown.ts` — what `make reload`
  calls now): the process asks itself to exit. launchd's `ExitTimeOut` only starts counting when
  launchd sends the signal and waits for the exit; a SELF-initiated exit never starts that clock
  at all. This path genuinely gets an unbounded window, `HTTP_DRAIN_GRACE_MS` (`Infinity`,
  derivation below) — the "wait as long as it takes" behavior the old `SHUTDOWN_GRACE_MS` always
  implied but never actually was, now actually true for the path it governs.
- **Signal-initiated** (a real SIGTERM/SIGINT — reboot, logout, `launchctl kill`, launchd
  itself, or `make reload`'s own fallback for when the HTTP endpoint doesn't answer): here
  launchd genuinely is the one waiting, so this path gets the short window,
  `SIGNAL_DRAIN_GRACE_MS` (45s — see below), sized against the measured 60s cap instead of
  against any job's actual duration.

Both constants live in `server/lib/shutdown.ts`; both are exercised by the SAME
`createShutdownController` state machine (`server/index.ts` passes a different `graceMs` per
trigger) — the drain/abort/escalation logic itself did not need to change, only how long each
trigger is allowed to wait.

A third, narrower kill surface sits alongside these two process-wide ones: `POST
/api/jobs/:id/cancel` (`server/jobs/store.ts`'s `cancelJob`) SIGTERMs a single job's worker via
`terminateSessionsForJob` without touching the process or any other job — it lands `cancelled`,
never `failed`, and shares no code path with `terminateActiveSessions()`'s drain-wide kill above.

### `HTTP_DRAIN_GRACE_MS` is unbounded — why a finite budget stopped making sense

This section used to derive a finite number (40 min, then 50 min as `depositBranch()` grew a
`check()` step) from `dispatch implement`'s own per-attempt `timeoutMs` and the bounded git/PR
work after it. As of 2026-09-12 that derivation no longer applies to anything: every worker
session's `maxTurns`/`timeoutMs`/absolute ceiling was removed (`server/mcp/session-runner.ts`
keeps only the idle watchdog — no stdout for `IDLE_TIMEOUT_MS`, 5 min), so there is no
per-attempt budget left to derive a drain window from. `HTTP_DRAIN_GRACE_MS` is now `Infinity`
(`server/lib/shutdown.ts`) — the self-initiated path (`POST /api/shutdown`, what `make reload`
calls) waits for every running job with no wall-clock cap at all.

Two changes landed in the same pass that make this safe rather than reckless:

1. **The idle watchdog is the only thing that can end a stalled session**, and it already
   existed independently of this window — a bounded drain used to exist to give up on a session
   that might simply be slow, but that job now belongs entirely to the watchdog. A drain window
   on top of it would only ever cut off a session that is still actively producing output — the
   dispatch `implement` case this whole section used to worry about losing.
2. **A worker killed anyway is no longer a dead end.** `server/jobs/store.ts`'s boot recovery
   (`dispatchRecoveryStatusFor`) resumes a `dispatch` episode that has a recorded `session_id`
   and an on-disk worktree from exactly where it stopped (`runSession`'s `resumeSessionId`,
   `--resume <id>` on the CLI) instead of discarding it. The previous derivation existed
   entirely because killing an `implement` episode lost everything it had done; that asymmetry
   is what changed. `server/index.ts` also reads `protectedWorktreePaths()` (`store.ts`) before
   the boot-time worktree sweep runs, so a resume-eligible worktree survives the same restart
   that would otherwise have deleted it as an ordinary leftover.

The historical percentile measurement (91 real jobs, three days of `~/Library/Logs/sideclaw.jsonl`)
and the per-step `depositBranch()` math that used to justify "50 min" are no longer reproduced
here — they motivated a number that no longer exists. `git log -p -- docs/deployment.md`
carries that derivation verbatim (2026-09-08 and 2026-09-11 revisions) if it's ever needed again.

**The old "four numbers move together" coupling — `ExitTimeOut` > `SHUTDOWN_GRACE_MS` +
`SHUTDOWN_FLUSH_MS`, with the Makefile poll ceiling outlasting `ExitTimeOut` on top — no longer
exists**, and that is not an oversight: it described a relationship this file now knows to be
false (launchd doesn't honor a raised `ExitTimeOut` past 60s regardless of the plist, so nothing
was ever actually "exceeding" it in the way the table implied). What replaces it is a handful of
independently-true facts:

| Constant | Where | Value | Role |
|-|-|-|-|
| `HTTP_DRAIN_GRACE_MS` | `server/lib/shutdown.ts` | `Infinity` | drain deadline for a self-initiated exit (`POST /api/shutdown`) — waits for every running job, unbounded, since nothing signals the process on this path and a worker killed anyway is now resumable |
| `SIGNAL_DRAIN_GRACE_MS` | `server/lib/shutdown.ts` | 45 s | drain deadline for a real SIGTERM — must stay under `LAUNCHD_HARD_EXIT_TIMEOUT_MS` with real margin, or launchd SIGKILLs mid-drain regardless of what this number says |
| `SHUTDOWN_FLUSH_MS` | `server/lib/shutdown.ts` | 3 s | HTTP response flush after the drain decision, stacked on top of whichever grace window applies |
| `LAUNCHD_HARD_EXIT_TIMEOUT_MS` | `server/lib/shutdown.ts` | 60 s | launchd's actual, measured ceiling — not a value this codebase controls, only observes |
| `ExitTimeOut` | `com.jkrumm.sideclaw-server.plist` | 60 s | set to exactly the measured cap, not a value implying more headroom than launchd grants |
| poll ceiling | `Makefile`'s `reload`/`install-agent` targets | none (unbounded) | how long `make reload` waits for the old PID to exit before `kickstart`ing — matches `HTTP_DRAIN_GRACE_MS` being unbounded; prints a progress line once a minute so a human watching can tell it's alive rather than hung |

Guards pin this in `bun test` rather than at the next reboot — all in `tests/shutdown-window.test.ts`
(replacing the old `tests/deployment-plist.test.ts` and `tests/makefile-poll-ceiling.test.ts`,
which pinned the coupling above that no longer holds): `SIGNAL_DRAIN_GRACE_MS + SHUTDOWN_FLUSH_MS
< LAUNCHD_HARD_EXIT_TIMEOUT_MS` with real margin, the plist's `ExitTimeOut` equals
`LAUNCHD_HARD_EXIT_TIMEOUT_MS` exactly, and the Makefile's drain-wait loops carry no numeric
`-lt N` ceiling at all. `tests/shutdown-dispatch-coupling.test.ts` now just pins
`HTTP_DRAIN_GRACE_MS === Infinity` directly — the cross-file relation it used to guard
(`HTTP_DRAIN_GRACE_MS` > `IMPLEMENT_SESSION_TIMEOUT_MS`) no longer applies since
`IMPLEMENT_SESSION_TIMEOUT_MS` was deleted in the same pass. `tests/shutdown-route.test.ts`
covers `POST /api/shutdown` itself (triggers the right `force`, responds before the drain
settles, degrades to 503 if no controller is registered).


### A plist edit needs `make install-agent`, not `make reload`

`launchctl kill` (what `make reload` falls back to when `POST /api/shutdown` doesn't answer —
see below; the normal path no longer signals the process at all) operates on the job
definition launchd already has **loaded in memory** — it does not re-read
`com.jkrumm.sideclaw-server.plist` from disk. Only `launchctl bootstrap` (`make install-agent`)
loads a changed plist. Measured live on this machine (2026-09-08): after raising the tracked
plist's `ExitTimeOut` from 20 (launchd's implicit default) to 1860, `launchctl print
gui/$(id -u)/com.jkrumm.sideclaw-server` kept reporting `exit timeout = 5` — a value from a
plist generation *before* the 1860 edit — because no `make install-agent` had run yet (a
measurement made before the later one, above, established that even a successfully-loaded
`ExitTimeOut` tops out at 60 regardless). Running the OLD `make reload` in that window would
have raised its in-process drain to double digits of minutes while launchd's own timer stayed at
5 seconds underneath it: the app would start a long drain, and launchd would SIGKILL it 5
seconds in regardless, silently discarding the drain change entirely — the exact class of
failure the HTTP-initiated path now sidesteps by not depending on launchd's timer in the first
place.

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

`launchctl bootout` (what `install-agent` relies on to clear the old job definition before
re-bootstrapping — unlike `reload`, `install-agent` was deliberately left on the signal path,
see below) is a REQUEST, not a guaranteed-blocking wait for the process to actually exit. It is
also, like every real signal, now subject to the measured 60s `ExitTimeOut` cap — `install-agent`
still only gets `SIGNAL_DRAIN_GRACE_MS` worth of drain, not `HTTP_DRAIN_GRACE_MS`, since it never
goes through `POST /api/shutdown`. If a job is running when someone runs `make install-agent`,
the old process can still be mid-drain — holding `:7705` for up to that window — while `cp` +
`bootstrap` immediately follow and spawn a NEW instance via `RunAtLoad`. That new instance's own
`app.listen()` fails to bind the still-held port and it crash-loops, while `install-agent`
reported success regardless: none of `bootout`/`cp`/`bootstrap` fail merely because a DIFFERENT
process couldn't bind a port, and the target's last line was an unconditional `echo`.

`install-agent` now carries the same PID-capture-and-poll `reload` already had (same unbounded
loop, no `-lt N` ceiling — `tests/shutdown-window.test.ts` pins that neither loop has one)
between the `bootout` and the `cp`/`bootstrap` that follow, and the same job-in-flight guard `reload` has
(refuses by default while a job is running; `FORCE=1` sends SIGINT — the catchable forced-abort
signal, never SIGKILL, for the same reason `reload`'s `FORCE=1` does — before `bootout`, then
proceeds without waiting). The target now also polls the new instance's `/health` after
`bootstrap` and exits non-zero with a pointer to the log if it never comes up, instead of the
previous unconditional "installed and started."

### FORCE=1: SIGINT (or its HTTP equivalent), never SIGKILL

`FORCE=1 make reload` exists to discard in-flight jobs rather than wait out a drain. Discarding
jobs does not require an unabortable process kill: SIGKILL is not catchable, so it would skip
both `POST /api/shutdown`'s trigger and `server/lib/shutdown.ts`'s `createShutdownController`
handler entirely, and with it `terminateActiveSessions()` — the `claude -p` worker subprocesses
have no process group detachment and no parent-death signal, so they'd survive as orphans that
keep writing/committing in their worktree (and, for an `implement` dispatch, could still push a
branch or open a PR) after the reload believed it had stopped them. `FORCE=1` asks for the same
forced abort the controller has always had — `POST /api/shutdown?force=1` on the normal path, or
a real SIGINT via `launchctl kill` on the fallback/`install-agent` path — which hits the *same*
handler with a zero-length grace period: draining is skipped (that's the whole point of FORCE)
but every worker is still terminated before the process exits. A forced abort that arrives while
an unforced drain is already running (an operator watching a normal `make reload` escalate with
`FORCE=1 make reload` against the same still-draining process, or the fallback's SIGINT landing
mid-HTTP-drain) escalates that drain to an immediate abort instead of being dropped by an
already-shutting-down latch — every worker is still terminated exactly once. A killed `implement`
dispatch's worktree
is bundled to `~/.local/state/sideclaw/salvage/` by the boot sweep before removal, same as a
real crash, and its job row is left `running` for the same boot's ordinary crash-recovery to
reconcile (see `execute()` in `server/jobs/store.ts`) rather than written `failed` — the whole
point being that a shutdown-killed job reads identically to a crashed one, everywhere.

### `draining` and boot grace in `GET /api/jobs/health`

`promote()` refuses every `pending → running` transition while a drain is in progress
(`setDraining()`, called from the SIGTERM/SIGINT handler) — a job promoted into the grace
window's dying process would just be interrupted and burn its one re-queue for nothing. That
means submissions genuinely back up during a reload, and with an unbounded drain window
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
