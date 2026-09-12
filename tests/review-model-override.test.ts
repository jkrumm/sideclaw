// `REVIEW_INPUT`'s `model` field (added alongside DISPATCH_INPUT's own `model`): the schema
// must actually accept and preserve it — before this field existed, `REVIEW_INPUT` being a
// plain `z.object` (not `z.strictObject`) meant an unknown `model` key was silently stripped
// by Zod rather than rejected, so a caller setting it would see no error and no effect. The
// MCP-facing half is the flip side: `model` must stay OFF that surface (server/mcp/tools/
// review.ts's `REVIEW_MCP_INPUT`) without becoming a hard rejection if it slips through.
//
// `runReview`'s actual threading of `model` into the angle/synthesis `runSession` calls (and
// its deliberate absence from the router call) has no seam to assert against here: this repo's
// test harness never mocks `runSession` for the review pipeline (review-scope.test.ts only
// exercises the pre-session throw paths — mutual exclusion, bad scope, bad branch ref — for the
// same reason: no fake exists for a real `claude` session). That threading was verified by
// reading the diff instead of by a test.

import { describe, expect, test } from "bun:test";
import { REVIEW_INPUT } from "../server/jobs/handlers/review.ts";
import { REVIEW_MCP_INPUT } from "../server/mcp/tools/review.ts";

describe("REVIEW_INPUT model field", () => {
  test("parses without `model`", () => {
    const parsed = REVIEW_INPUT.parse({ cwd: "/tmp/repo" });
    expect(parsed.model).toBeUndefined();
  });

  test("parses with `model` present and preserves it", () => {
    const parsed = REVIEW_INPUT.parse({ cwd: "/tmp/repo", model: "claude-opus-5[1m]" });
    expect(parsed.model).toBe("claude-opus-5[1m]");
  });

  test("rejects a non-string `model`", () => {
    expect(() => REVIEW_INPUT.parse({ cwd: "/tmp/repo", model: 123 })).toThrow();
  });
});

describe("REVIEW_MCP_INPUT", () => {
  test("does not expose `model` on the MCP-facing shape", () => {
    expect(REVIEW_MCP_INPUT.shape).not.toHaveProperty("model");
  });

  test("still exposes every other REVIEW_INPUT field", () => {
    const jobKeys = Object.keys(REVIEW_INPUT.shape);
    const mcpKeys = Object.keys(REVIEW_MCP_INPUT.shape);
    expect(mcpKeys).toEqual(jobKeys.filter((k) => k !== "model"));
  });

  test("a `model` key slipping through is stripped, not rejected", () => {
    // Plain z.object, same non-strict shape as REVIEW_INPUT — parsing an object that still
    // carries `model` (e.g. a client that ignores the advertised schema) must silently drop
    // it, not throw, since dropping it is the intended MCP-side behaviour.
    const parsed = REVIEW_MCP_INPUT.parse({ cwd: "/tmp/repo", model: "claude-opus-5[1m]" });
    expect(parsed).not.toHaveProperty("model");
  });
});
