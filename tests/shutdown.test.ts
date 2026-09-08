// Pure drain-loop predicate AND the injectable state machine behind the SIGTERM/SIGINT
// handlers in server/index.ts. Split into server/lib/shutdown.ts specifically so both are
// importable without pulling in index.ts's module-scope side effects (it opens the :7705 HTTP
// listener at import time) and, for the controller, without real signals or real timers.

import { describe, expect, test } from "bun:test";
import {
  createShutdownController,
  shouldKeepDraining,
  type ShutdownDeps,
} from "../server/lib/shutdown.ts";

describe("shouldKeepDraining", () => {
  test("stops early once nothing is running, well before the deadline", () => {
    expect(shouldKeepDraining(0, 1_000, 10_000)).toBe(false);
  });

  test("keeps polling while jobs are running and the deadline has not passed", () => {
    expect(shouldKeepDraining(2, 1_000, 10_000)).toBe(true);
  });

  test("stops exactly on the deadline even with jobs still running — deadline is exclusive", () => {
    expect(shouldKeepDraining(2, 10_000, 10_000)).toBe(false);
  });

  test("stops once the deadline has passed, jobs still running", () => {
    expect(shouldKeepDraining(2, 10_001, 10_000)).toBe(false);
  });
});

// ── createShutdownController ────────────────────────────────────────────────

/** A fully controllable fake of every ShutdownDeps member: a mutable clock, a mutable
 *  `running` count the test drives directly (standing in for the job queue), and spies on
 *  every side-effecting call so a test can assert exactly how many times each fired. */
function fakeDeps(): ShutdownDeps & {
  clock: { now: number };
  running: { count: number };
  terminateCalls: number;
  exitCalls: number;
  flushes: (() => void)[];
  markDrainKilledCalls: string[][];
  markDrainCompletedCalls: number;
} {
  const clock = { now: 0 };
  const running = { count: 0 };
  const self = {
    clock,
    running,
    terminateCalls: 0,
    exitCalls: 0,
    flushes: [] as (() => void)[],
    markDrainKilledCalls: [] as string[][],
    markDrainCompletedCalls: 0,
    terminateActiveSessions: () => {
      self.terminateCalls++;
      // One synthetic job id per "running" job, standing in for the real ids
      // terminateActiveSessions() returns — good enough for a fake that only needs to prove
      // markDrainKilled gets called with something derived from this call.
      return Array.from({ length: running.count }, (_, i) => `job-${i}`);
    },
    activeSessionCount: () => running.count,
    queueStats: () => ({ running: running.count }),
    setDraining: () => {},
    markDrainKilled: (jobIds: string[]) => {
      self.markDrainKilledCalls.push(jobIds);
    },
    markDrainCompleted: () => {
      self.markDrainCompletedCalls++;
    },
    log: () => {},
    exit: () => {
      self.exitCalls++;
    },
    now: () => clock.now,
    scheduleFlush: (cb: () => void) => {
      self.flushes.push(cb);
    },
  };
  return self;
}

describe("createShutdownController", () => {
  test("normal drain: SIGTERM waits until the queue empties, then terminates exactly once", () => {
    const deps = fakeDeps();
    deps.running.count = 1;
    const controller = createShutdownController(deps);

    controller.begin("SIGTERM", 100_000);
    expect(controller.isActive()).toBe(true);

    // Still running, well inside the deadline — ticking must not finish early.
    deps.clock.now = 1_000;
    controller.tick();
    expect(controller.isActive()).toBe(true);
    expect(deps.terminateCalls).toBe(0);

    // The job finishes on its own; the next tick sees the empty queue and finishes cleanly.
    deps.running.count = 0;
    controller.tick();
    expect(controller.isActive()).toBe(false);
    expect(deps.terminateCalls).toBe(1);
    expect(deps.flushes).toHaveLength(1);
    expect(deps.exitCalls).toBe(0); // exit only runs once the flush callback fires
    deps.flushes[0]?.();
    expect(deps.exitCalls).toBe(1);
  });

  test("forced abort: SIGINT with zero grace terminates immediately, no tick needed", () => {
    const deps = fakeDeps();
    deps.running.count = 3;
    const controller = createShutdownController(deps);

    controller.begin("SIGINT", 0);

    expect(controller.isActive()).toBe(false);
    expect(deps.terminateCalls).toBe(1);
    expect(deps.flushes).toHaveLength(1);
  });

  test("SIGINT escalates an in-progress SIGTERM drain to an immediate abort instead of being dropped", () => {
    const deps = fakeDeps();
    deps.running.count = 1;
    const controller = createShutdownController(deps);

    controller.begin("SIGTERM", 100_000);
    deps.clock.now = 1_000;
    controller.tick(); // still well inside the 100s window — confirms the drain is genuinely running
    expect(controller.isActive()).toBe(true);
    expect(deps.terminateCalls).toBe(0);

    // The job is still running, but the operator escalates. The old `shuttingDown` latch
    // would have silently dropped this; the fix must shorten the deadline to "now" instead.
    controller.begin("SIGINT", 0);

    expect(controller.isActive()).toBe(false);
    expect(deps.terminateCalls).toBe(1);

    // A tick that arrives after the escalation (the interval owner hasn't cleared itself
    // yet) must not terminate a second time.
    controller.tick();
    expect(deps.terminateCalls).toBe(1);
  });

  test("SIGINT arriving while the drain tick is mid-poll (still not past its deadline) still escalates cleanly", () => {
    const deps = fakeDeps();
    deps.running.count = 2;
    const controller = createShutdownController(deps);

    controller.begin("SIGTERM", 50_000);
    deps.clock.now = 500;
    controller.tick(); // a normal poll that decides "keep draining" — running > 0, deadline far off
    expect(controller.isActive()).toBe(true);

    controller.begin("SIGINT", 0); // escalation arrives right after that tick decided to continue
    expect(deps.terminateCalls).toBe(1);
    expect(controller.isActive()).toBe(false);
  });

  test("a SIGINT that arrives after the drain already finished (the flush window) is a no-op", () => {
    const deps = fakeDeps();
    deps.running.count = 0; // already empty — the first SIGTERM finishes immediately
    const controller = createShutdownController(deps);

    controller.begin("SIGTERM", 100_000);
    expect(controller.isActive()).toBe(false);
    expect(deps.terminateCalls).toBe(1);
    expect(deps.flushes).toHaveLength(1);

    // A second signal now — simulating one arriving during the SHUTDOWN_FLUSH_MS window
    // before the real process.exit(0) actually fires — must not terminate or schedule a
    // second flush.
    controller.begin("SIGINT", 0);
    expect(deps.terminateCalls).toBe(1);
    expect(deps.flushes).toHaveLength(1);
  });

  test("a repeated SIGTERM is idempotent — it never extends or shortens a drain already running", () => {
    const deps = fakeDeps();
    deps.running.count = 1;
    const controller = createShutdownController(deps);

    controller.begin("SIGTERM", 10_000); // deadline = now(0) + 10_000 = 10_000
    controller.begin("SIGTERM", 999_999_999); // must NOT move the deadline out to here

    deps.clock.now = 10_000; // exactly the ORIGINAL deadline
    controller.tick();
    expect(controller.isActive()).toBe(false); // still finished on schedule — proves no extension
    expect(deps.terminateCalls).toBe(1);
  });

  test("a repeated SIGINT during a forced abort never terminates or exits twice", () => {
    const deps = fakeDeps();
    deps.running.count = 1;
    const controller = createShutdownController(deps);

    controller.begin("SIGINT", 0);
    controller.begin("SIGINT", 0);
    controller.begin("SIGINT", 0);

    expect(deps.terminateCalls).toBe(1);
    expect(deps.flushes).toHaveLength(1);
  });

  test("markDrainKilled is called with exactly what terminateActiveSessions returned, before exit — store.ts needs this recorded before a killed job's own execute() catch can run", () => {
    const deps = fakeDeps();
    deps.running.count = 2;
    const controller = createShutdownController(deps);

    controller.begin("SIGINT", 0);

    expect(deps.markDrainKilledCalls).toEqual([["job-0", "job-1"]]);
  });

  test("grace period exhaustion with jobs still running still terminates exactly once", () => {
    const deps = fakeDeps();
    deps.running.count = 5;
    const controller = createShutdownController(deps);

    controller.begin("SIGTERM", 1_000);
    deps.clock.now = 999;
    controller.tick();
    expect(controller.isActive()).toBe(true); // one instant before the deadline — still draining

    deps.clock.now = 1_000; // deadline reached, jobs are STILL running
    controller.tick();
    expect(controller.isActive()).toBe(false);
    expect(deps.terminateCalls).toBe(1);
  });
});

// The marker exists so the NEXT boot can tell an orderly exit from a crash. What matters is
// that it is written when the shutdown path REACHES ITS END, not when a signal arrives — a
// start-time marker survives a mid-drain SIGKILL and would hand the health grace to the very
// crash loop it is meant to expose.
describe("drain-completed marker", () => {
  test("is not written merely because a drain started", () => {
    const deps = fakeDeps();
    deps.running.count = 1;
    const c = createShutdownController(deps);
    c.begin("SIGTERM", 100_000);
    expect(deps.markDrainCompletedCalls).toBe(0);
  });

  test("is written once the drain finishes normally", () => {
    const deps = fakeDeps();
    const c = createShutdownController(deps);
    c.begin("SIGTERM", 100_000);
    c.tick();
    expect(deps.markDrainCompletedCalls).toBe(1);
  });

  test("is written on a forced abort — that is still an orderly exit", () => {
    const deps = fakeDeps();
    deps.running.count = 2;
    const c = createShutdownController(deps);
    c.begin("SIGINT", 0);
    expect(deps.markDrainCompletedCalls).toBe(1);
  });

  test("is written exactly once when the grace period expires with jobs left", () => {
    const deps = fakeDeps();
    deps.running.count = 1;
    const c = createShutdownController(deps);
    c.begin("SIGTERM", 100_000);
    deps.clock.now = 100_001;
    c.tick();
    c.tick();
    expect(deps.markDrainCompletedCalls).toBe(1);
  });
});
