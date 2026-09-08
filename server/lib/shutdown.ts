// Pure/injectable half of the SIGTERM/SIGINT drain in server/index.ts, split out because
// index.ts is the app entrypoint — it opens the HTTP listener at module scope, so importing it
// from a test would bind :7705 a second time against the live LaunchAgent. This file has no
// side effects and is safe to import directly, including from tests/deployment-plist.test.ts,
// which pins the plist's `ExitTimeOut` against the two constants below, and from
// tests/shutdown.test.ts, which drives `createShutdownController` with fake deps and a fake
// clock instead of real signals/timers.

// ── Drain window sizing ──────────────────────────────────────────────────────
//
// Must equal dispatch.ts's `TIERS.implement.timeoutMs` — pinned by
// tests/shutdown-dispatch-coupling.test.ts, kept as an independent literal (not a runtime
// import of dispatch.ts) so this module stays free of that handler's import graph
// (session-runner, octokit, routing) rather than importing dispatch.ts just for one number.
export const IMPLEMENT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// A single `dispatch implement` attempt can legitimately run up to its own configured
// `timeoutMs` — but NOT "and never longer", which is what an earlier version of this file
// claimed (first "never longer than its own timeout", then a revision that covered only the
// rare provider-retry fallback chain and still undercounted). Two independent retry mechanisms
// can each double that number, and the more reachable of the two is the ORDINARY path, not an
// edge case:
//
//   - `dispatch.ts`'s own handler-level salvage retry (`isSalvageable()`) fires on a
//     `max_turns` error or a schema/parse failure — hitting the turn budget without emitting
//     valid JSON, or emitting JSON that doesn't validate. That is a routine way for a session
//     to end badly, not a rare fault. The retry is a FRESH `runSession()` call with a smaller
//     turn budget (`retryTurns`) but the SAME `timeoutMs` ceiling as the first attempt — so the
//     reachable chain through this path alone is two full `timeoutMs` windows, 2 × 30 min =
//     60 min of session wall-clock, with no timeout and no provider-side signal required on
//     either attempt.
//   - `runSession()`'s own internal retry/fallback ladder (server/mcp/session-runner.ts) is a
//     SEPARATE mechanism that can also double a single attempt's wall-clock. A timeout's error
//     text ("Session timed out after Xms") never matches `isRetryableSessionError` (no HTTP
//     status, no connection-reset pattern), so the same-backend transient retry never fires for
//     a hang. The ONE lane switch that CAN follow a timeout is `max` → `iu` (dispatch's route:
//     primary `max`, fallback `{ backend: "iu" }`, same model), and only when `hadApiRetry` was
//     observed mid-run (the CLI itself saw a provider-side 429/529 before the hang) —
//     `usedFallback` then latches, so the `iu` attempt that follows can itself only return or
//     hang to completion, never retry or switch again. This path is rarer (it needs that
//     mid-hang provider signal) but reaches the same 60-minute figure for one `runEpisode` call.
//
// The two do not compound past 60 minutes for a single `runEpisode` call: `isSalvageable()`
// explicitly excludes a timeout (`noOutput` is never set on that return path, and the error
// text matches neither `max_structured_output_retries` nor `max_turns`), so a hang that
// exhausts the internal fallback throws straight to the job failure with no further dispatch.ts
// retry stacked on top. But that bounds only the fallback chain at 60 min — it does not make
// the OTHER chain (the salvage retry, triggered by the ordinary max_turns/schema case) any
// rarer, and that one is reachable on any `implement` episode that simply runs long and fumbles
// its JSON, no timeout or provider retry involved at all.
//
// So the reachable worst case is ~70 minutes (2 × 30 min of session wall-clock, from either
// chain — most plausibly the ordinary salvage retry — plus `depositBranch()`'s own bounded
// teardown, below), not the 40 minutes this window actually covers.
//
// A drain window covering that reachable 70-minute chain would put a `make reload` worst case
// past an hour. That is not a usable operational number — a drain nobody actually waits out
// just teaches everyone to reach for `FORCE=1`, which discards work rather than waiting for it,
// so this file does NOT try to cover either doubling. It covers the DOMINANT path instead — a
// single attempt (no retry triggered — the common case is still a session that either finishes
// or fails outright inside its own budget) running up to its own full `timeoutMs`, followed by
// `depositBranch()`'s fully bounded worst case:
//
//   commitPendingWork (add + diff --cached + commit, 60s each) = 180s
//   commitCount (rev-list, 60s)                                =  60s
//   summarizeDiff (diff --numstat, 60s)                        =  60s
//   diffRefusalReason → addedSecrets (diff -U0, 60s)           =  60s
//   pushBranch (rev-parse 60s + push, explicit 180s timeout)   = 240s
//                                                          total = 600s = 10 min
//
// (`openPullRequest`'s Octokit call carries no explicit timeout of its own and is not folded
// into this figure — a genuine network hang there is a different failure class than "legitimate
// slow work", not one this window is trying to buy time for.)
//
// 30 min + 10 min = 40 min covers the dominant single-attempt path in full. Both retry chains
// above (~60-70 min combined with teardown) are deliberately NOT covered — including the
// ordinary salvage-retry one, which needs no timeout and no provider signal to reach. A job
// caught by either is killed at the grace deadline like any other still-running job, and —
// since server/jobs/store.ts's `execute()` leaves a drain-killed job's row untouched at
// `running` instead of writing `failed` — the next boot's ordinary crash-recovery reconciles
// it exactly like a crash. `dispatch` is deliberately absent from `REQUEUE_ON_RECOVER` (an
// `implement` episode may already have pushed a branch or opened a PR before the kill), so it
// lands on `interrupted`, not a silent automatic re-run — the caller sees a truthful "this got
// cut off mid-flight" instead of either a silently discarded job or a second episode racing a
// repo the first one may have already changed. Doubling every reload's worst-case wait to cover
// a chain reachable this ordinarily is a worse trade than that.
export const SHUTDOWN_GRACE_MS = IMPLEMENT_SESSION_TIMEOUT_MS + 10 * 60 * 1000;

// Small window after the drain decision (either fully drained, grace period exhausted, or a
// SIGINT forced/escalated abort) before the process actually exits — gives an in-flight HTTP
// response (a `job_wait` poll reading the job that JUST finished, or any other request
// mid-write) time to flush to the socket. Without this, exiting in the same tick that frees the
// last running slot can cut off the response for what was otherwise a *successful* job.
export const SHUTDOWN_FLUSH_MS = 3_000;

/** Keep polling the drain loop while jobs remain running AND the deadline hasn't passed yet.
 *  `now === deadline` is treated as "stop" (`<`, not `<=`) — the deadline is the last instant
 *  still inside the grace window, not one past it. */
export function shouldKeepDraining(running: number, now: number, deadline: number): boolean {
  return running > 0 && now < deadline;
}

// ── Controller ────────────────────────────────────────────────────────────────
//
// Everything server/index.ts's SIGTERM/SIGINT handlers need, injected so the state machine
// below is testable without real signals, real timers, or a real job queue. `log` takes a
// level because the two outcomes (drain vs forced abort) both log at "info" today, but a
// future caller (e.g. an unexpected double-signal) may want "warn" without a second dependency.

export interface ShutdownDeps {
  /** Kill every active worker subprocess. Returns the ids of the jobs those subprocesses
   *  belonged to (a session run outside the job system contributes nothing). Must be safe to
   *  call more than once (idempotent) — the controller already guards against calling it
   *  twice, but this is the last line of defense against a wiring bug. */
  terminateActiveSessions: () => string[];
  /** Worker subprocesses alive right now — logged once, at the start of a drain. */
  activeSessionCount: () => number;
  queueStats: () => { running: number };
  /** Marks the job store as draining — `promote()` then refuses new `pending → running`
   *  transitions for the rest of this process's life, so a job promoted into the grace
   *  window's dying process is never possible. */
  setDraining: () => void;
  /** Records exactly which jobs' subprocess this drain just terminated, BEFORE their
   *  `execute()` catch can run (that catch fires only once the killed subprocess's promise
   *  settles, strictly after this synchronous call returns) — lets store.ts leave only those
   *  rows `running` for boot recovery while a genuinely unrelated failure landing in the same
   *  drain window still gets written `failed`. See the comment on `execute()`'s catch block. */
  markDrainKilled: (jobIds: string[]) => void;
  /** Records that this process reached the end of its shutdown path, so the NEXT boot can tell
   *  an orderly exit from a crash. Deliberately here and not at `setDraining()`: a marker
   *  written when the drain begins survives a mid-drain SIGKILL and would hand the next boot's
   *  health grace to a crash loop. */
  markDrainCompleted: () => void;
  log: (level: "info" | "warn", fields: Record<string, unknown>, msg: string) => void;
  exit: (code: number) => void;
  now: () => number;
  /** Schedule `cb` to run after `ms` — `setTimeout` in production, synchronous or manually
   *  driven in tests. */
  scheduleFlush: (cb: () => void, ms: number) => void;
}

export interface ShutdownController {
  /** Handle one SIGTERM/SIGINT delivery. Safe to call repeatedly, including a SIGINT that
   *  arrives while a SIGTERM drain from an earlier call is still in progress (escalation —
   *  see below) and a SIGTERM or SIGINT that arrives after a drain has already finished
   *  (both are no-ops). */
  begin(signal: "SIGTERM" | "SIGINT", graceMs: number): void;
  /** Poll once — call periodically (every 500 ms in production) while `isActive()` is true.
   *  A no-op once the drain has already finished or never started. */
  tick(): void;
  /** True from the first `begin()` call until the drain has finished — the caller uses this
   *  to decide whether to keep polling `tick()` (and can stop its own interval once false). */
  isActive(): boolean;
}

/** Builds the drain state machine shared by SIGTERM (graceMs = SHUTDOWN_GRACE_MS, drain) and
 *  SIGINT (graceMs = 0, forced abort). `terminateActiveSessions()` always runs exactly once
 *  per shutdown episode, on whichever path reaches `finish()` first — a forced abort still
 *  leaves no orphaned worker, the only difference is how long it waits first.
 *
 *  The one case this exists to fix: SIGTERM starts a 40-minute drain, the operator watches it
 *  sit there and escalates with `FORCE=1 make reload` (SIGINT) — that SIGINT must SHORTEN the
 *  already-running drain to an immediate abort, not be silently dropped by a "we're already
 *  shutting down" latch. A `shuttingDown` boolean alone (the previous implementation) treats
 *  every second signal as a no-op regardless of which one it is; this one instead:
 *    - lets the FIRST SIGINT during an in-progress, not-yet-forced SIGTERM drain collapse the
 *      deadline to "now" and finish immediately (not merely "next 500 ms tick"),
 *    - stays idempotent for a repeated SIGTERM (never extends or shortens a running drain),
 *    - stays idempotent for a repeated SIGINT (never terminates or exits twice), whether it
 *      arrives while a drain tick is in flight or after `finish()` has already run and the
 *      process is sitting in its `SHUTDOWN_FLUSH_MS` exit window. */
export function createShutdownController(deps: ShutdownDeps): ShutdownController {
  let shuttingDown = false;
  let forced = false;
  let finished = false;
  let deadline = 0;

  function finish(): void {
    if (finished) return;
    finished = true;
    const left = deps.queueStats().running;
    const killedJobIds = deps.terminateActiveSessions();
    // Must run before scheduleFlush — store.ts needs these ids recorded before the killed
    // subprocess's own promise settles and its execute() catch runs (see markDrainKilled's
    // doc comment on ShutdownDeps).
    deps.markDrainKilled(killedJobIds);
    deps.markDrainCompleted();
    const killed = killedJobIds.length;
    deps.log(
      "info",
      {
        event: "app.shutdown",
        running: left,
        killedWorkers: killed,
        flushMs: SHUTDOWN_FLUSH_MS,
        forced,
      },
      forced
        ? `forced abort — ${killed} worker(s) killed, ${left} job(s) abandoned`
        : left > 0
          ? "grace period over — exiting with jobs still running"
          : "drained — exiting",
    );
    deps.scheduleFlush(() => deps.exit(0), SHUTDOWN_FLUSH_MS);
  }

  function begin(signal: "SIGTERM" | "SIGINT", graceMs: number): void {
    if (shuttingDown) {
      // Escalation: a SIGINT arriving while a not-yet-forced drain is still in progress
      // shortens it to an immediate abort. Everything else on this branch is a no-op:
      // `finished` (a drain that already ran, whether it's SIGTERM waiting out its own
      // deadline or a completed abort, sitting in the flush window), a repeated SIGTERM
      // (must never extend or shorten a running drain), or a repeated SIGINT (`forced`
      // already true — never terminate/exit twice).
      if (finished || signal !== "SIGINT" || forced) return;
      forced = true;
      deadline = deps.now();
      deps.log(
        "info",
        { event: "app.shutdown", escalate: true },
        "SIGINT — escalating the in-progress drain to an immediate abort",
      );
      finish();
      return;
    }
    shuttingDown = true;
    forced = signal === "SIGINT";
    deps.setDraining();
    const { running } = deps.queueStats();
    deadline = deps.now() + graceMs;
    deps.log(
      "info",
      { event: "app.shutdown", running, workers: deps.activeSessionCount(), graceMs, forced },
      forced ? "SIGINT — forced abort, abandoning running jobs" : "SIGTERM — draining running jobs",
    );
    if (!shouldKeepDraining(running, deps.now(), deadline)) finish();
  }

  function tick(): void {
    if (!shuttingDown || finished) return;
    if (shouldKeepDraining(deps.queueStats().running, deps.now(), deadline)) return;
    finish();
  }

  return { begin, tick, isActive: () => shuttingDown && !finished };
}
