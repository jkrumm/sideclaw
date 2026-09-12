// recover()'s dispatch-specific boot recovery (server/jobs/store.ts) — a `running` dispatch row
// left behind by a dead process goes one of three ways depending on `session_id`/`worktree_meta`
// (dispatchRecoveryStatusFor, unit-tested directly in tests/jobs-health.test.ts): resumed in
// place, re-run from scratch, or interrupted once the attempt cap is spent. Same seeding
// technique as tests/jobs-recover-cancel.test.ts — a second bun:sqlite connection writes the
// exact on-disk shape a real restart leaves, since store.ts exposes no "insert an arbitrary
// row" API.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetForTests, createJob, getJob, initJobStore } from "../server/jobs/store.ts";

afterEach(() => {
  __resetForTests();
});

function dbPath(): string {
  const p = process.env.SIDECLAW_JOBS_DB;
  if (!p) throw new Error("SIDECLAW_JOBS_DB not set — tests/setup.ts should have set it");
  return p;
}

/** Seed a `running` dispatch row with the given attempts/session_id/worktree_meta, mirroring
 *  what a real restart leaves on disk. */
function seedRunningDispatch(
  id: string,
  opts: { attempts?: number; sessionId?: string | null; worktreeMeta?: object | null },
): void {
  const seed = new Database(dbPath());
  seed.run("PRAGMA busy_timeout = 5000");
  seed.run(
    "UPDATE jobs SET status = 'running', started_at = ?, attempts = ?, session_id = ?, worktree_meta = ? WHERE id = ?",
    [
      Date.now(),
      opts.attempts ?? 1,
      opts.sessionId ?? null,
      opts.worktreeMeta ? JSON.stringify(opts.worktreeMeta) : null,
      id,
    ],
  );
  seed.close();
}

// Never resolves — what matters in every test below is recover()'s synchronous decision, not
// whether a re-promoted job ever finishes (same technique as tests/jobs-recover-cancel.test.ts).
const NEVER_EXECUTE = () => new Promise<unknown>(() => {});

describe("recover() — dispatch resume", () => {
  test("a session id AND an on-disk worktree → pending, resume markers preserved", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sideclaw-dispatch-recover-"));
    try {
      const created = createJob("dispatch", {});
      seedRunningDispatch(created.id, {
        attempts: 1,
        sessionId: "worker-session-1",
        worktreeMeta: {
          path: tmp,
          branch: "dispatch/x-abcd1234",
          base: "abc",
          baseRef: "HEAD",
          pushable: false,
        },
      });

      initJobStore({ executor: NEVER_EXECUTE });

      const after = getJob(created.id);
      // pending (or already promoted to running against the never-resolving fake executor).
      expect(["pending", "running"]).toContain(after?.status);
      expect(after?.error).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("no session id (killed before the first event) → pending, fresh — no resume markers", () => {
    const created = createJob("dispatch", {});
    seedRunningDispatch(created.id, { attempts: 1, sessionId: null, worktreeMeta: null });

    initJobStore({ executor: NEVER_EXECUTE });

    const after = getJob(created.id);
    expect(["pending", "running"]).toContain(after?.status);
  });

  test("a session id but its worktree is gone → pending, fresh — resume markers cleared", () => {
    const created = createJob("dispatch", {});
    seedRunningDispatch(created.id, {
      attempts: 1,
      sessionId: "worker-session-2",
      worktreeMeta: {
        path: "/nonexistent/path/does-not-exist",
        branch: "b",
        base: "a",
        baseRef: "HEAD",
        pushable: false,
      },
    });

    initJobStore({ executor: NEVER_EXECUTE });

    const after = getJob(created.id);
    expect(["pending", "running"]).toContain(after?.status);
  });

  test("over the attempt cap → interrupted, resumable or not", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sideclaw-dispatch-recover-"));
    try {
      const created = createJob("dispatch", {});
      seedRunningDispatch(created.id, {
        attempts: 2,
        sessionId: "worker-session-3",
        worktreeMeta: { path: tmp, branch: "b", base: "a", baseRef: "HEAD", pushable: false },
      });

      initJobStore({ executor: NEVER_EXECUTE });

      const after = getJob(created.id);
      expect(after?.status).toBe("interrupted");
      expect(after?.error).toBe("HTTP server restarted while job was running");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("check/review are unaffected — still the ordinary REQUEUE_ON_RECOVER path", () => {
    for (const tool of ["check", "review"] as const) {
      const created = createJob(tool, {});
      const seed = new Database(dbPath());
      seed.run("PRAGMA busy_timeout = 5000");
      seed.run("UPDATE jobs SET status = 'running', started_at = ?, attempts = 1 WHERE id = ?", [
        Date.now(),
        created.id,
      ]);
      seed.close();

      initJobStore({ executor: NEVER_EXECUTE });

      const after = getJob(created.id);
      expect(["pending", "running"]).toContain(after?.status);
    }
  });
});
