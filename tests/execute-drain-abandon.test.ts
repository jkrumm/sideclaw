// Drives a real job through store.ts's private execute()/promote() — the only way to reach its
// catch block — to pin the distinction server/jobs/store.ts's execute() now makes: a job whose
// worker `terminateActiveSessions()` actually killed stays `running` for the next boot's crash
// recovery, but a job that merely fails to land in the same drain window (an unrelated bug, not
// a kill) is still written `failed`. The previous round treated every failure seen while
// `draining` was true as shutdown-caused; the fix is `markDrainKilled` naming the exact job ids
// a drain terminated, checked here instead of the `draining` flag alone.
//
// Needs `__resetForTests()` (`server/jobs/store.ts`) both to clean up its own module-singleton
// state (`draining`, `drainKilledIds`, `executor`) and to leave the shared test sqlite file
// (tests/setup.ts — one file for the whole `bun test` run) empty for every other test file's
// "empty store" assumptions.

import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetForTests,
  createJob,
  getJob,
  initJobStore,
  markDrainKilled,
  setDraining,
} from "../server/jobs/store.ts";

afterEach(() => {
  __resetForTests();
});

/** Flushes the microtask/macrotask queue far enough for promote()'s fire-and-forget
 *  `void execute(job)` to run its executor, hit the catch block, and finish its synchronous DB
 *  writes. A plain `await Promise.resolve()` is not reliably enough ticks for that whole chain. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("execute()'s drain-abandon distinction", () => {
  test("a job whose subprocess the drain actually killed stays `running`, not `failed`", async () => {
    initJobStore({
      executor: async (job) => {
        // Stands in for server/lib/shutdown.ts's finish(): terminateActiveSessions() kills the
        // worker and markDrainKilled records exactly this job's id BEFORE the throw below
        // reaches execute()'s catch — same order the real shutdown controller uses.
        setDraining();
        markDrainKilled([job.id]);
        throw new Error("Session exited with code 143");
      },
    });

    const view = createJob("check", {});
    await flush();

    const after = getJob(view.id);
    expect(after?.status).toBe("running");
    // The row is left exactly as promote() wrote it — no error recorded — so the next boot's
    // recover() reconciles it via the ordinary running-row path, not a real failure.
    expect(after?.error).toBeNull();
  });

  test("a genuinely unrelated failure landing in the same drain window is still written `failed`", async () => {
    initJobStore({
      executor: async (_job) => {
        // draining is true (a real drain IS in progress), but this job's own subprocess was
        // never one terminateActiveSessions() signaled — markDrainKilled is never called for
        // it. This must not be masked as "abandoned mid-drain".
        setDraining();
        throw new Error("unrelated bug: undefined is not a function");
      },
    });

    const view = createJob("check", {});
    await flush();

    const after = getJob(view.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toContain("unrelated bug");
  });
});
