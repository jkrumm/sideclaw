// recover() (server/jobs/store.ts, run once at HTTP server boot via initJobStore) against a
// `running` row whose cancel_requested_at was set before the process died — the exact gap
// cancelJob() can leave: the SIGTERM lands, but the server restarts before execute()'s catch
// ever observes the killed worker's rejected promise. Without this check the row would follow
// the ordinary REQUEUE_ON_RECOVER path and silently resume a job an operator asked to stop.
//
// Seeds the row via a second bun:sqlite connection to the same test DB file
// (tests/setup.ts points SIDECLAW_JOBS_DB at one shared temp file for the whole run) — store.ts
// exposes no "insert an arbitrary row" API, and this is the most direct way to reproduce
// exactly the on-disk state a real restart leaves.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { __resetForTests, createJob, getJob, initJobStore } from "../server/jobs/store.ts";

afterEach(() => {
  __resetForTests();
});

function dbPath(): string {
  const p = process.env.SIDECLAW_JOBS_DB;
  if (!p) throw new Error("SIDECLAW_JOBS_DB not set — tests/setup.ts should have set it");
  return p;
}

describe("recover() and a persisted cancel request", () => {
  test("a running row with cancel_requested_at set lands cancelled on boot, never pending or interrupted", async () => {
    // Created `pending` (no executor registered yet), then flipped to `running` +
    // `cancel_requested_at` directly on disk — the on-disk shape a real cancelJob() SIGTERM
    // followed by a restart leaves, without needing a real subprocess or a real HTTP restart.
    const created = createJob("check", {});
    const seed = new Database(dbPath());
    seed.run("PRAGMA busy_timeout = 5000");
    const now = Date.now();
    seed.run(
      "UPDATE jobs SET status = 'running', started_at = ?, cancel_requested_at = ? WHERE id = ?",
      [now, now, created.id],
    );
    seed.close();

    // "check" is in REQUEUE_ON_RECOVER — if the cancel_requested_at check did not run first,
    // this would come back `pending` (then likely `running` again once promote() picks it up).
    initJobStore({ executor: async () => ({ shouldNeverRun: true }) });

    const after = getJob(created.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.error).toBe("cancelled by request");
    expect(after?.cancelRequested).toBe(true);
  });

  test("a running row with NO cancel request still follows the ordinary requeue path, unaffected", async () => {
    const created = createJob("check", {});
    const seed = new Database(dbPath());
    seed.run("PRAGMA busy_timeout = 5000");
    seed.run("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?", [
      Date.now(),
      created.id,
    ]);
    seed.close();

    // A hanging executor: what matters here is recover()'s synchronous decision, not whether
    // the re-promoted job ever finishes.
    initJobStore({ executor: () => new Promise(() => {}) });

    const after = getJob(created.id);
    expect(after?.status).not.toBe("cancelled");
    // "check" (REQUEUE_ON_RECOVER, attempts 0 < MAX_RECOVER_ATTEMPTS) goes pending → running.
    expect(["pending", "running"]).toContain(after?.status);
  });
});
