// Pure/injectable half of the SIGTERM/SIGINT drain in server/index.ts, split out because
// index.ts is the app entrypoint — it opens the HTTP listener at module scope, so importing it
// from a test would bind :7705 a second time against the live LaunchAgent. This file has no
// side effects and is safe to import directly, including from tests/shutdown-window.test.ts,
// which pins the plist's `ExitTimeOut` against the two constants below, and from
// tests/shutdown.test.ts, which drives `createShutdownController` with fake deps and a fake
// clock instead of real signals/timers.

// ── Drain window sizing ──────────────────────────────────────────────────────
//
// Two different triggers reach this drain, and they get two DIFFERENT windows because only one
// of them is bounded by an external clock:
//
//   - HTTP-initiated (`POST /api/shutdown`, what `make reload` calls — see server/routes/
//     shutdown.ts): the process asks itself to exit. launchd's `ExitTimeOut` only fires when
//     launchd sends a signal and then waits for the process to die — a SELF-initiated exit
//     never starts that clock at all, so this window is free to wait as long as it likes.
//     `HTTP_DRAIN_GRACE_MS`, below, is unbounded.
//   - Signal-initiated (a real SIGTERM/SIGINT: reboot, logout, `launchctl kill`, launchd
//     itself, or `make reload`'s own fallback for when the HTTP endpoint doesn't answer):
//     here launchd IS the one waiting, and its `ExitTimeOut` is hard-capped at 60s regardless
//     of what the plist says — measured on this host 2026-09-08: raising the tracked plist's
//     `ExitTimeOut` to 2700 changed nothing (`launchctl print
//     gui/<uid>/com.jkrumm.sideclaw-server` still reported `exit timeout = 60`), and a control
//     probe at 120 confirmed the same ceiling. A window here that doesn't stay comfortably
//     under that cap gets SIGKILLed mid-drain — no app-level flush, no
//     `terminateActiveSessions()`, an orphaned `claude -p` worker left writing into its
//     worktree. `SIGNAL_DRAIN_GRACE_MS`, below.
//
// The 40-minute HTTP-side number used to be the ONLY window, applied uniformly to both
// triggers — that was fiction: launchd's ExitTimeOut caps at 60s no matter what this file (or
// the plist) claims, so a real SIGTERM was always going to be SIGKILLed around the 60s mark
// regardless of what SHUTDOWN_GRACE_MS said. Splitting the two constants makes each one true
// for the path it actually governs.

// `HTTP_DRAIN_GRACE_MS` is unbounded (owner decision, 2026-09-12) — the self-initiated path
// waits for every running job with no wall-clock cap at all, rather than a guessed "dominant
// case" figure. This is safe now in a way it was not before two other changes landed in the
// same pass:
//
//   1. No worker session has a turn limit or a wall-clock ceiling of its own any more
//      (`server/mcp/session-runner.ts`) — the ONLY thing that ends a stalled session is the
//      idle watchdog (`IDLE_TIMEOUT_MS`, no stdout for 5 min). A bounded drain window used to
//      exist to give up on a session that might simply be slow; that job now belongs entirely
//      to the idle watchdog, so a drain window here would only ever cut off a session that is
//      still actively producing output — the exact case worth waiting for, not bounding.
//   2. A worker actually killed anyway — this window expiring is no longer the only way that
//      happens; a crash, `FORCE=1`, or launchd's own `ExitTimeOut` on the signal path all still
//      can — is no longer a dead end. `server/jobs/store.ts`'s boot recovery
//      (`dispatchRecoveryStatusFor`) resumes a `dispatch` episode that has a recorded
//      `session_id` and an on-disk worktree from exactly where it stopped
//      (`runSession`'s `resumeSessionId`) instead of discarding it — so waiting here is no
//      longer the only thing standing between a long episode and losing its work. A previous
//      revision of this file derived a finite number (~50 min) from `dispatch implement`'s own
//      per-step timeouts specifically because killing it lost everything; that asymmetry is
//      what changed.
//
// The result: the HTTP path waits out whatever is genuinely still running, for as long as it
// keeps producing output, and a real kill on top of that (idle timeout, a crash, `FORCE=1`) is
// recoverable rather than catastrophic. `Infinity + x === Infinity`, so `SHUTDOWN_FLUSH_MS`
// stacked on top below is definitionally a no-op for this constant — it only matters for the
// signal path, which stays finite.
export const HTTP_DRAIN_GRACE_MS = Infinity;

// The signal-initiated counterpart (a real SIGTERM/SIGINT — see the two-window note above).
// Must stay under LAUNCHD_HARD_EXIT_TIMEOUT_MS WITH real margin for SHUTDOWN_FLUSH_MS stacked
// on top: 45s + 3s = 48s, leaving 12s of slack under the 60s cap. There is no "dominant path"
// reasoning to apply here the way there is for HTTP_DRAIN_GRACE_MS above — whatever job
// launchd's signal happens to land on gets whatever is left of these 45s, then is SIGKILLed
// regardless, so this number is sized purely against the external cap, not against any job's
// actual worst-case duration. A drain-killed job's row is left `running` for the next boot's
// ordinary crash-recovery to reconcile — same as the HTTP path, same as a real crash (see
// server/jobs/store.ts's `execute()`).
export const SIGNAL_DRAIN_GRACE_MS = 45 * 1000;

// launchd's actual, measured `ExitTimeOut` ceiling — see the two-window note above. A named
// constant (not a bare `60_000` at each call site) so tests can pin both
// SIGNAL_DRAIN_GRACE_MS and the plist's own ExitTimeOut against the same fact instead of two
// independent copies of "60".
export const LAUNCHD_HARD_EXIT_TIMEOUT_MS = 60 * 1000;

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

/** Where a shutdown request came from. `"signal"` is a real OS signal (SIGTERM/SIGINT) —
 *  launchd is genuinely waiting on this path and its `ExitTimeOut` hard-caps it (see
 *  `LAUNCHD_HARD_EXIT_TIMEOUT_MS` above). `"http"` is a self-initiated exit via
 *  `POST /api/shutdown` — nothing external is waiting, so it can drain for as long as
 *  `HTTP_DRAIN_GRACE_MS` allows. This is a fact about WHO is waiting on the exit, kept separate
 *  from `ShutdownMode` (WHETHER jobs get abandoned) — `force=1` over HTTP and a real SIGINT are
 *  both `"forced"`, but only one of them is `"signal"`, and only `"signal"` origins are bounded
 *  by launchd's clock. Naming an HTTP-triggered forced call `"SIGINT"` (the previous
 *  representation) made both the escalation logic and the shutdown log read as if a real signal
 *  had arrived when a self-initiated `make reload` triggered it — this type exists so that
 *  distinction survives into the log and the escalation decision below. */
export type ShutdownOrigin = "signal" | "http";

/** How hard the request is: `"graceful"` waits out the relevant drain window, `"forced"`
 *  abandons running jobs and terminates immediately (a real SIGINT, or
 *  `force=1`/`force=true` on `POST /api/shutdown`). */
export type ShutdownMode = "graceful" | "forced";

export interface ShutdownController {
  /** Handle one shutdown request. Safe to call repeatedly, including a forced request that
   *  arrives while a graceful drain from an earlier call is still in progress (escalation —
   *  see below), a signal-origin graceful request landing on top of an already-running drain
   *  (shortening — see below), and any request that arrives after a drain has already finished
   *  (a no-op). */
  begin(origin: ShutdownOrigin, mode: ShutdownMode, graceMs: number): void;
  /** Poll once — call periodically (every 500 ms in production) while `isActive()` is true.
   *  A no-op once the drain has already finished or never started. */
  tick(): void;
  /** True from the first `begin()` call until the drain has finished — the caller uses this
   *  to decide whether to keep polling `tick()` (and can stop its own interval once false). */
  isActive(): boolean;
}

/** Builds the drain state machine shared by every trigger — a signal-origin graceful call
 *  (`graceMs = SIGNAL_DRAIN_GRACE_MS`), an http-origin graceful call
 *  (`graceMs = HTTP_DRAIN_GRACE_MS`), and a forced call from either origin (`graceMs = 0`).
 *  `terminateActiveSessions()` always runs exactly once per shutdown episode, on whichever path
 *  reaches `finish()` first — a forced abort still leaves no orphaned worker, the only
 *  difference is how long it waits first.
 *
 *  A request landing on top of an already-running, not-yet-finished drain is decided by the
 *  INCOMING call's `mode`/`origin`, never by what started the original drain:
 *    - `mode: "forced"` (a real SIGINT, or `force=1`/`force=true` over HTTP) always collapses
 *      the drain to an immediate abort, regardless of origin — abandoning jobs is a decision
 *      about hardness, not about who is waiting on the exit. The one case this half exists to
 *      fix: an http-origin drain starts a 40-minute window, the operator watches it sit there
 *      and escalates with `FORCE=1 make reload` — that forced request must SHORTEN the
 *      already-running drain to an immediate abort, not be silently dropped by a "we're already
 *      shutting down" latch. A bare `shuttingDown` boolean (an earlier implementation) treats
 *      every second request as a no-op regardless of which one it is.
 *    - `origin: "signal"` with `mode: "graceful"` (a real SIGTERM landing on top of a
 *      still-running drain, whatever started it) means launchd is now genuinely waiting and its
 *      `ExitTimeOut` applies — the deadline must SHRINK to whatever's left of the signal-safe
 *      window (`min(deadline, now + graceMs)`), never silently no-op the signal away. The case
 *      this half exists to fix: an http-origin drain is in progress, a real reboot/logout sends
 *      SIGTERM on top of it — launchd starts waiting the moment that signal lands, and the
 *      unbounded http-side deadline underneath it would get the whole process SIGKILLed with no
 *      app-level flush at all if this branch didn't cap it first.
 *    - an http-origin graceful request landing on a running drain changes nothing — the same
 *      idempotence a repeated signal-origin graceful request always had (never extends OR
 *      shortens what launchd isn't yet waiting on).
 *  Every branch also stays idempotent for a repeated forced request (never terminates or exits
 *  twice), whether it arrives while a drain tick is in flight or after `finish()` has already
 *  run and the process is sitting in its `SHUTDOWN_FLUSH_MS` exit window. */
export function createShutdownController(deps: ShutdownDeps): ShutdownController {
  let shuttingDown = false;
  let forced = false;
  let finished = false;
  let deadline = 0;
  // The origin most recently responsible for the drain's current deadline/outcome — starts as
  // whatever triggered `begin()` first, and moves to `"signal"` if a real signal later
  // shortens or escalates an http-origin drain (see `begin()` below). Logged on both `begin`
  // and `finish` so `app.shutdown` never reads as a real signal when a self-initiated
  // `POST /api/shutdown` triggered it, or vice versa.
  let activeOrigin: ShutdownOrigin = "http";

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
        origin: activeOrigin,
      },
      forced
        ? `forced abort — ${killed} worker(s) killed, ${left} job(s) abandoned`
        : left > 0
          ? "grace period over — exiting with jobs still running"
          : "drained — exiting",
    );
    deps.scheduleFlush(() => deps.exit(0), SHUTDOWN_FLUSH_MS);
  }

  /** A shutdown request arriving while one is already in progress. Three outcomes, by axis:
   *  `forced` (either origin) collapses the deadline and aborts now; a real signal on a longer
   *  drain shortens it to the signal-safe window, because once launchd is waiting its ~60 s cap
   *  governs and the long window is no longer enforceable; a graceful http request changes
   *  nothing. Split out of `begin()` so each reads as one decision. */
  function escalate(origin: ShutdownOrigin, mode: ShutdownMode, graceMs: number): void {
    if (finished) return;
    if (mode === "forced") {
      if (forced) return; // repeated forced request — never terminate/exit twice
      forced = true;
      activeOrigin = origin;
      deadline = deps.now();
      deps.log(
        "info",
        { event: "app.shutdown", escalate: true, origin },
        `${origin} — escalating the in-progress drain to an immediate abort`,
      );
      finish();
      return;
    }
    if (origin === "signal") {
      const signalDeadline = deps.now() + graceMs;
      if (signalDeadline >= deadline) return; // already at least this tight — no-op
      deadline = signalDeadline;
      activeOrigin = origin;
      deps.log(
        "info",
        { event: "app.shutdown", shortened: true, origin, graceMs },
        "a real signal landed on an in-progress drain — shortening the deadline to the signal-safe window",
      );
      return;
    }
    // A graceful http-origin request landing on an already-running drain: no-op.
    return;
  }

  function begin(origin: ShutdownOrigin, mode: ShutdownMode, graceMs: number): void {
    if (shuttingDown) {
      escalate(origin, mode, graceMs);
      return;
    }
    shuttingDown = true;
    forced = mode === "forced";
    activeOrigin = origin;
    deps.setDraining();
    const { running } = deps.queueStats();
    // `forced` means abandon now, so it ignores graceMs here exactly as the escalation branch
    // above does. Today every forced caller passes 0 anyway; deriving it from `mode` instead of
    // trusting that keeps a future caller from logging a drain as forced while it quietly waits.
    deadline = deps.now() + (mode === "forced" ? 0 : graceMs);
    deps.log(
      "info",
      {
        event: "app.shutdown",
        running,
        workers: deps.activeSessionCount(),
        graceMs,
        forced,
        origin,
      },
      forced
        ? `${origin} — forced abort, abandoning running jobs`
        : `${origin} — draining running jobs`,
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

/** Maps `POST /api/shutdown`'s `force` query flag to the `begin()` call it must produce — pulled
 *  out of index.ts's trigger callback so the mapping itself is unit-testable (a flipped ternary
 *  here would otherwise pass every existing test: `tests/shutdown.test.ts` drives the state
 *  machine directly with explicit `origin`/`mode` args, never through this translation). Origin
 *  is always `"http"` — this function only exists for the `force` half of the decision. */
export function httpShutdownParams(force: boolean): {
  origin: "http";
  mode: ShutdownMode;
  graceMs: number;
} {
  return force
    ? { origin: "http", mode: "forced", graceMs: 0 }
    : { origin: "http", mode: "graceful", graceMs: HTTP_DRAIN_GRACE_MS };
}

// ── HTTP-triggered self-shutdown ────────────────────────────────────────────
//
// index.ts is the only place that owns a live ShutdownController — it wires the SAME instance
// to both the OS signal handlers (process.on("SIGTERM"/"SIGINT")) and this registration slot,
// right after building it. server/routes/shutdown.ts can't hold that instance directly: every
// route in server/routes/ is a plain, stateless Elysia plugin that reaches shared state by
// importing it from a lib module (see jobs.ts ← jobs/store.ts, routing.ts ← lib/routing.ts),
// never via a constructor argument — and index.ts importing routes while a route imports back
// from index.ts would be circular. Registering the trigger here, instead, lets the route reach
// the live controller through the same lib layer every other route already uses.
let activeTrigger: ((force: boolean) => { running: number }) | null = null;

/** Called once from index.ts, right after the real ShutdownController and its signal wiring
 *  exist. Not called at all in a route-only test that never boots index.ts — `triggerShutdown`
 *  returns null in that case rather than throwing, so the route can answer with a clear error
 *  instead of a crash. */
export function registerShutdownTrigger(trigger: (force: boolean) => { running: number }): void {
  activeTrigger = trigger;
}

/** Test-only: clears the registration so one test file's fake trigger can never leak into
 *  another's assertions. */
export function __resetShutdownTriggerForTests(): void {
  activeTrigger = null;
}

/** POST /api/shutdown's entire implementation. Returns the `running` job count observed at the
 *  moment the drain/abort was requested (before the drain proceeds asynchronously), or `null`
 *  if no trigger is registered yet. */
export function triggerShutdown(force: boolean): { running: number } | null {
  return activeTrigger?.(force) ?? null;
}
