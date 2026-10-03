// The salvaged `needs-human` verdict for a synthesis that never serialized, and the
// consumer-facing requeue signal it must carry. The full review pipeline has no seam to
// mock `runSession` against (`review-model-override.test.ts` says why), so the verdict
// builder is exported pure and asserted directly — the same seam dispatch's `salvage` uses.

import { describe, expect, test } from "bun:test";
import {
  REVIEW_OUTPUT,
  REVIEW_SCHEMA_VERSION,
  salvagedVerdict,
} from "../server/jobs/handlers/review.ts";

describe("salvagedVerdict", () => {
  test("a Max weekly-limit failure is marked upstreamLimit/retryable, not an ordinary escalation", () => {
    // The exact shape job fbda02ed logged: the constructed error says nothing, the limit
    // notice is the synthesizer's only output (rawText), and there is no api_retry event.
    const verdict = salvagedVerdict(
      {
        error: "Session exited with code 1 after a success result envelope",
        classificationText: "Session exited with code 1 after a success result envelope",
        rawText: "You've hit your weekly limit · resets 6pm (Europe/Berlin)",
      },
      5,
    );
    expect(verdict.outcome).toBe("needs-human");
    expect(verdict.upstreamLimit).toBe(true);
    expect(verdict.retryable).toBe(true);
    expect(verdict.schemaVersion).toBe(1);
  });

  test("a genuine serialization failure carries no upstream-limit signal", () => {
    const verdict = salvagedVerdict(
      {
        error: "Synthesis did not return valid JSON",
        classificationText: "Synthesis did not return valid JSON",
        rawText: "Here is my review in prose, sorry about the JSON.",
      },
      5,
    );
    expect(verdict.outcome).toBe("needs-human");
    expect(verdict.upstreamLimit).toBe(false);
    expect(verdict.retryable).toBe(false);
  });

  test("preserves the raw synthesizer text for manual triage on both paths", () => {
    const verdict = salvagedVerdict(
      { error: "boom", rawText: "partial findings: something real" },
      4,
    );
    expect(verdict.discussions[0]?.message).toContain("partial findings: something real");
    expect(verdict.summary).toContain("4 reviewers");
  });
});

describe("REVIEW_OUTPUT published shape", () => {
  test("declares the optional upstream-limit fields a consumer requeues on", () => {
    expect(REVIEW_OUTPUT.shape.upstreamLimit).toBeDefined();
    expect(REVIEW_OUTPUT.shape.retryable).toBeDefined();
    const verdict = salvagedVerdict({ error: "x" }, 1);
    expect(REVIEW_OUTPUT.parse(verdict).upstreamLimit).toBe(false);
  });

  test("keeps schemaVersion at 1 — the new fields are optional and additive, so a pinned consumer still parses", () => {
    expect(REVIEW_SCHEMA_VERSION).toBe(1);
    expect(salvagedVerdict({ error: "x" }, 1).schemaVersion).toBe(1);
  });
});
