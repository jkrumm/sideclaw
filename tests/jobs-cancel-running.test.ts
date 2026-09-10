// Drives a real job through store.ts's private execute() (same technique as
// tests/execute-drain-abandon.test.ts) with a controllable fake executor standing in for a
// worker session, to pin cancelJob's `running` semantics: the cancel only *requests* — the
// actual `cancelled` transition happens in execute()'s catch once the (fake) SIGTERM'd
// session's promise rejects, exactly as `terminateSessionsForJob` + a real `claude -p` exiting
// non-zero would produce.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetForTests,
  cancelJob,
  createJob,
  getJob,
  initJobStore,
  isCancelRequested,
} from "../server/jobs/store.ts";

afterEach(() => {
  __resetForTests();
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function cancelRequestedAtColumn(id: string): number | null {
  const p = process.env.SIDECLAW_JOBS_DB;
  if (!p) throw new Error("SIDECLAW_JOBS_DB not set — tests/setup.ts should have set it");
  const db = new Database(p);
  db.run("PRAGMA busy_timeout = 5000");
  const row = db
    .query<{ cancel_requested_at: number | null }, [string]>(
      "SELECT cancel_requested_at FROM jobs WHERE id = ?",
    )
    .get(id);
  db.close();
  return row?.cancel_requested_at ?? null;
}

describe("cancelJob against a running job", () => {
  test("flags cancelRequested; the SIGTERM'd worker throwing lands the job cancelled, not failed, and clears the flag", async () => {
    let rejectExecutor!: (err: Error) => void;
    const hang = new Promise<unknown>((_resolve, reject) => {
      rejectExecutor = reject;
    });
    initJobStore({ executor: async () => hang });

    const created = createJob("check", {});
    await flush(); // let promote() pull it into `running`
    expect(getJob(created.id)?.status).toBe("running");

    const cancelled = cancelJob(created.id);
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      // Only the request is reflected — the row itself is still `running` at this instant.
      expect(cancelled.job.status).toBe("running");
      expect(cancelled.job.cancelRequested).toBe(true);
    }
    expect(isCancelRequested(created.id)).toBe(true);

    // Stand-in for terminateSessionsForJob's SIGTERM landing on the real subprocess, which
    // makes runSessionAttempt/runSession's promise reject with a distinguishable error.
    rejectExecutor(new Error("Session exited with code 143"));
    await flush();

    const after = getJob(created.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.error).toBe("cancelled by request");
    expect(isCancelRequested(created.id)).toBe(false);
  });

  test("a race — the session completes normally despite a cancel request — lets `done` stand and clears the flag", async () => {
    let resolveExecutor!: (value: unknown) => void;
    const hang = new Promise<unknown>((resolve) => {
      resolveExecutor = resolve;
    });
    initJobStore({ executor: async () => hang });

    const created = createJob("check", {});
    await flush();
    expect(getJob(created.id)?.status).toBe("running");

    cancelJob(created.id);
    expect(isCancelRequested(created.id)).toBe(true);

    // The worker had already produced its result before the SIGTERM could land.
    resolveExecutor({ fine: true });
    await flush();

    const after = getJob(created.id);
    expect(after?.status).toBe("done");
    expect(isCancelRequested(created.id)).toBe(false);
  });

  test("a repeat cancel on an already-requested running job is a no-op — no duplicate SIGTERM/timer, cancel_requested_at unchanged", async () => {
    initJobStore({ executor: async () => new Promise(() => {}) }); // never resolves
    const created = createJob("check", {});
    await flush();
    expect(getJob(created.id)?.status).toBe("running");

    const first = cancelJob(created.id);
    expect(first.ok).toBe(true);
    const firstStamp = cancelRequestedAtColumn(created.id);
    expect(firstStamp).not.toBeNull();

    // A second call must take the early-return path in cancelJob's `running` branch — the
    // persisted timestamp must be the exact same value, not overwritten by a second UPDATE
    // (which would also mean a second, redundant terminateSessionsForJob call).
    const second = cancelJob(created.id);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.job.status).toBe("running");
      expect(second.job.cancelRequested).toBe(true);
    }
    expect(cancelRequestedAtColumn(created.id)).toBe(firstStamp);
  });

  test("unknown id while nothing is running → 404, no state mutated", () => {
    const result = cancelJob("does-not-exist");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
    }
  });
});
