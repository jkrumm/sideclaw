// Pure halves of the job store's boot recovery and health verdict (server/jobs/store.ts).
// The sqlite-backed functions around them run against a temp DB (tests/setup.ts).

import { describe, expect, test } from "bun:test";
import {
  BOOT_HEALTH_GRACE_MS,
  __resetForTests,
  dispatchRecoveryStatusFor,
  evaluateJobHealth,
  jobFinishLogFields,
  jobHealth,
  recoveryStatusFor,
  setDraining,
} from "../server/jobs/store.ts";
import { jobsRoutes } from "../server/routes/jobs.ts";
import {
  recordFallback,
  recordRouteOutcome,
  ROUTE_STREAK_LIMIT,
} from "../server/mcp/session-runner.ts";

describe("recoveryStatusFor", () => {
  test("idempotent read-only tools are re-queued once", () => {
    for (const tool of ["check", "overview", "narrative", "review"] as const) {
      expect(recoveryStatusFor(tool, 1)).toBe("pending");
      expect(recoveryStatusFor(tool, 2)).toBe("interrupted");
    }
  });

  test("this generic path never auto re-runs dispatch — it has its own decision below", () => {
    // recover() never actually calls recoveryStatusFor for a dispatch row in production
    // (dispatchRecoveryStatusFor below is dispatch's real path) — pinned here anyway so this
    // function stays honest if something ever calls it with "dispatch" directly.
    expect(recoveryStatusFor("dispatch", 1)).toBe("interrupted");
    expect(recoveryStatusFor("excalidraw_diagram", 1)).toBe("interrupted");
  });
});

describe("dispatchRecoveryStatusFor", () => {
  test("resumes when a session id was recorded and its worktree is still on disk", () => {
    expect(dispatchRecoveryStatusFor(0, true, true)).toBe("resume");
    expect(dispatchRecoveryStatusFor(1, true, true)).toBe("resume");
  });

  test("re-runs from scratch when no session id was ever recorded", () => {
    expect(dispatchRecoveryStatusFor(0, false, true)).toBe("fresh");
    expect(dispatchRecoveryStatusFor(0, false, false)).toBe("fresh");
  });

  test("re-runs from scratch when the session id survived but its worktree did not", () => {
    expect(dispatchRecoveryStatusFor(0, true, false)).toBe("fresh");
  });

  test("interrupts once the attempt cap is spent, resume-eligible or not", () => {
    expect(dispatchRecoveryStatusFor(2, true, true)).toBe("interrupted");
    expect(dispatchRecoveryStatusFor(2, false, true)).toBe("interrupted");
  });
});

describe("jobFinishLogFields", () => {
  test("carries tool and a duration measured from startedAt, so job.done/job.fail need no jobId join to analyze", () => {
    const job = { id: "j1", tool: "review" as const, startedAt: 1_000, createdAt: 500 };
    const fields = jobFinishLogFields(job, "done", {}, 4_000);
    expect(fields).toEqual({
      event: "job.done",
      jobId: "j1",
      tool: "review",
      durationMs: 3_000,
      error: undefined,
    });
  });

  test("failed jobs log the error and still get a duration", () => {
    const job = { id: "j2", tool: "check" as const, startedAt: 1_000, createdAt: 500 };
    const fields = jobFinishLogFields(job, "failed", { error: "boom" }, 6_000);
    expect(fields).toEqual({
      event: "job.fail",
      jobId: "j2",
      tool: "check",
      durationMs: 5_000,
      error: "boom",
    });
  });

  test("falls back to createdAt when startedAt is null — defensive, not currently reachable via finish(): every real caller is execute() ← promote(), which always sets started_at before execute() ever runs, and store.ts's new drain-abandon path (`draining` in execute()'s catch) skips finish() entirely rather than calling it with a stale job. Kept covered because JobRecord's type still allows null and a future caller is not guaranteed to uphold the invariant", () => {
    const job = { id: "j3", tool: "overview" as const, startedAt: null, createdAt: 1_000 };
    const fields = jobFinishLogFields(job, "done", {}, 2_500);
    expect(fields.durationMs).toBe(1_500);
  });

  test("durationMs === 0 when now lands exactly on startedAt", () => {
    const job = { id: "j4", tool: "narrative" as const, startedAt: 5_000, createdAt: 4_000 };
    const fields = jobFinishLogFields(job, "done", {}, 5_000);
    expect(fields.durationMs).toBe(0);
  });

  test("a clock jump backwards (now < startedAt) surfaces as a negative duration, not clamped away — the drain-window sizing in docs/deployment.md is built by aggregating this exact field, and silently flooring it at 0 would hide the very clock skew that field is meant to expose", () => {
    const job = { id: "j5", tool: "dispatch" as const, startedAt: 10_000, createdAt: 9_000 };
    const fields = jobFinishLogFields(job, "failed", { error: "clock skew" }, 8_000);
    expect(fields.durationMs).toBe(-2_000);
  });
});

describe("evaluateJobHealth", () => {
  // sinceBootMs starts well past BOOT_HEALTH_GRACE_MS, and recoveredFromDrain starts false, so
  // the boot-grace exemption doesn't silently mask what every other test in this block is
  // actually checking.
  const base = {
    running: 0,
    pending: 0,
    failedLastHour: 0,
    interruptedLastHour: 0,
    oldestPendingAgeMs: null,
    lastFailure: null,
    draining: false,
    sinceBootMs: BOOT_HEALTH_GRACE_MS + 1,
    recoveredFromDrain: false,
  };

  test("healthy by default", () => {
    expect(evaluateJobHealth(base).ok).toBe(true);
  });

  test("three failures in the hour trip it; two do not", () => {
    expect(evaluateJobHealth({ ...base, failedLastHour: 2 }).ok).toBe(true);
    expect(evaluateJobHealth({ ...base, failedLastHour: 3 }).ok).toBe(false);
  });

  test("a pending job older than 15 minutes trips it; exactly 15 does not", () => {
    expect(evaluateJobHealth({ ...base, oldestPendingAgeMs: 15 * 60 * 1000 }).ok).toBe(true);
    expect(evaluateJobHealth({ ...base, oldestPendingAgeMs: 15 * 60 * 1000 + 1 }).ok).toBe(false);
  });

  test("interruptions alone never trip it — they are the reload's expected residue", () => {
    expect(evaluateJobHealth({ ...base, interruptedLastHour: 10 }).ok).toBe(true);
  });

  test("a stale pending job does not trip it while draining — that latency is promote()'s own doing", () => {
    expect(
      evaluateJobHealth({ ...base, draining: true, oldestPendingAgeMs: 60 * 60 * 1000 }).ok,
    ).toBe(true);
  });

  test("draining does not mask a real failure lane — failures still trip it", () => {
    expect(evaluateJobHealth({ ...base, draining: true, failedLastHour: 3 }).ok).toBe(false);
  });

  test("a stale pending job does not trip it fresh after an ORDERLY restart — the backlog is promote()'s own doing, not a wedge", () => {
    expect(
      evaluateJobHealth({
        ...base,
        sinceBootMs: 0,
        recoveredFromDrain: true,
        oldestPendingAgeMs: 60 * 60 * 1000,
      }).ok,
    ).toBe(true);
  });

  test("the boot grace expires — a stale pending job trips it again once sinceBootMs clears the threshold, even after an orderly restart", () => {
    expect(
      evaluateJobHealth({
        ...base,
        sinceBootMs: BOOT_HEALTH_GRACE_MS + 1,
        recoveredFromDrain: true,
        oldestPendingAgeMs: 60 * 60 * 1000,
      }).ok,
    ).toBe(false);
  });

  test("the boot grace does not mask a real failure lane either", () => {
    expect(
      evaluateJobHealth({
        ...base,
        sinceBootMs: 0,
        recoveredFromDrain: true,
        failedLastHour: 3,
      }).ok,
    ).toBe(false);
  });

  test("a fresh boot with NO preceding orderly drain gets no grace at all — the crash-loop case: a real backlog must not hide behind 'just restarted'", () => {
    expect(
      evaluateJobHealth({
        ...base,
        sinceBootMs: 0,
        recoveredFromDrain: false,
        oldestPendingAgeMs: 60 * 60 * 1000,
      }).ok,
    ).toBe(false);
  });
});

describe("jobHealth against an empty store", () => {
  test("reports the documented shape", () => {
    const h = jobHealth();
    expect(h.ok).toBe(true);
    expect(h).toMatchObject({
      running: 0,
      failedLastHour: 0,
      interruptedLastHour: 0,
      oldestPendingAgeMs: null,
      lastFailure: null,
      draining: false,
      // No prior process wrote the drain_completed marker for this fresh test DB — this boot
      // never "recovered from a drain", same as a real crash-loop restart.
      recoveredFromDrain: false,
    });
    expect(typeof h.pending).toBe("number");
    expect(typeof h.sinceBootMs).toBe("number");
  });
});

describe("GET /api/jobs/health", () => {
  test("carries backendFallbacks alongside the job-store health fields, not just jobHealth()'s own shape", async () => {
    const res = await jobsRoutes.handle(new Request("http://localhost/api/jobs/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.backendFallbacks).toEqual({
      count: expect.any(Number),
      reasons: expect.any(Object),
    });
  });

  // The drain fields are only ever read by a consumer (devhost-health, an operator during a
  // reload), never by this codebase, so nothing else would notice if jobHealth()'s object
  // literal quietly stopped emitting one. Assert the wire shape, not just the pure evaluator.
  test("reports the drain-state fields a consumer branches on", async () => {
    const res = await jobsRoutes.handle(new Request("http://localhost/api/jobs/health"));
    const body = await res.json();
    expect(body.draining).toBe(false);
    expect(body.recoveredFromDrain).toBe(false);
    expect(typeof body.sinceBootMs).toBe("number");
  });

  test("reports draining once a drain has begun", async () => {
    // `draining` is module-scope state shared by every test file in one `bun test` process,
    // so this must not leak — reset rather than rely on file ordering.
    try {
      setDraining();
      const res = await jobsRoutes.handle(new Request("http://localhost/api/jobs/health"));
      const body = await res.json();
      expect(body.draining).toBe(true);
    } finally {
      __resetForTests();
    }
  });

  test("carries routeStreaks/degradedRoutes/warnings, and a degraded route never flips ok to false", async () => {
    // Unique route keys per test — routeFailureStreaks() is module-scope state shared
    // across this whole `bun test` process, same caveat as `draining` above.
    const tool = "jobs-health-route";
    recordRouteOutcome(tool, "iu", "glm-5.3-flash", false);
    recordRouteOutcome(tool, "iu", "glm-5.3-flash", false);
    recordRouteOutcome(tool, "iu", "glm-5.3-flash", false);
    expect(ROUTE_STREAK_LIMIT).toBe(3);

    const res = await jobsRoutes.handle(new Request("http://localhost/api/jobs/health"));
    const body = await res.json();
    const key = `${tool}@iu/glm-5.3-flash`;

    expect(body.ok).toBe(true);
    expect(body.routeStreaks[key]).toBe(3);
    expect(body.degradedRoutes).toContain(key);
    expect(body.warnings).toContain(`route ${key} failed 3 in a row`);

    // Reset so this route doesn't leak a stale streak into a later test in this file.
    recordRouteOutcome(tool, "iu", "glm-5.3-flash", true);
  });

  test("warnings lists a backend-fallback count alongside any degraded route", async () => {
    recordFallback("iu-unavailable", "jobs-health-fallback-tool");
    const res = await jobsRoutes.handle(new Request("http://localhost/api/jobs/health"));
    const body = await res.json();
    expect(body.backendFallbacks.count).toBeGreaterThanOrEqual(1);
    expect(
      body.warnings.some((w: string) => w.includes("backend fallback(s) in the last hour")),
    ).toBe(true);
  });

  test("a route that has never failed stays out of routeStreaks AND never contributes a warning naming it", async () => {
    // `warnings` is asserted directly here, not just `routeStreaks` — `body.warnings` is
    // process-global across this whole file (other tests record fallbacks/streaks under
    // their own keys), so the only thing this test can honestly claim is that THIS
    // route's own key never appears in it, not that the array is empty.
    const tool = "jobs-health-clean-route";
    const key = `${tool}@iu/glm-5.3-flash`;
    recordRouteOutcome(tool, "iu", "glm-5.3-flash", true); // resets/never-fails, stays out of the report
    const res = await jobsRoutes.handle(new Request("http://localhost/api/jobs/health"));
    const body = await res.json();
    expect(body.routeStreaks[key]).toBeUndefined();
    expect(body.degradedRoutes).not.toContain(key);
    expect(body.warnings.some((w: string) => w.includes(key))).toBe(false);
  });

  test("a streak below ROUTE_STREAK_LIMIT appears in routeStreaks but not degradedRoutes/warnings", async () => {
    const tool = "jobs-health-below-limit";
    const key = `${tool}@iu/glm-5.3-flash`;
    recordRouteOutcome(tool, "iu", "glm-5.3-flash", false);
    recordRouteOutcome(tool, "iu", "glm-5.3-flash", false); // 2 < ROUTE_STREAK_LIMIT (3)

    const res = await jobsRoutes.handle(new Request("http://localhost/api/jobs/health"));
    const body = await res.json();

    expect(body.routeStreaks[key]).toBe(2);
    expect(body.degradedRoutes).not.toContain(key);
    expect(body.warnings.some((w: string) => w.includes(key))).toBe(false);

    // Reset so this route doesn't leak a stale streak into a later test in this file.
    recordRouteOutcome(tool, "iu", "glm-5.3-flash", true);
  });
});
