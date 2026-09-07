// Pure halves of the job store's boot recovery and health verdict (server/jobs/store.ts).
// The sqlite-backed functions around them run against a temp DB (tests/setup.ts).

import { describe, expect, test } from "bun:test";
import { evaluateJobHealth, jobHealth, recoveryStatusFor } from "../server/jobs/store.ts";

describe("recoveryStatusFor", () => {
  test("idempotent read-only tools are re-queued once", () => {
    for (const tool of ["check", "overview", "narrative", "review"] as const) {
      expect(recoveryStatusFor(tool, 1)).toBe("pending");
      expect(recoveryStatusFor(tool, 2)).toBe("interrupted");
    }
  });

  test("dispatch is never auto re-run — an implement episode may already have pushed", () => {
    expect(recoveryStatusFor("dispatch", 1)).toBe("interrupted");
    expect(recoveryStatusFor("excalidraw_diagram", 1)).toBe("interrupted");
  });
});

describe("evaluateJobHealth", () => {
  const base = {
    running: 0,
    pending: 0,
    failedLastHour: 0,
    interruptedLastHour: 0,
    oldestPendingAgeMs: null,
    lastFailure: null,
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
    });
    expect(typeof h.pending).toBe("number");
  });
});
