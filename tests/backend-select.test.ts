// The failure-text classifier (`isQuotaError`) that gates the reactive `max` → `iu`
// retry in `runSession`. No subprocess, no mocks, no network.
//
// This file used to also cover the proactive Max-quota-ceiling pre-check
// (`chooseBackend`, `parseQuotaFile`/`parseQuotaApi`) — removed 2026-09-08 along
// with the feature itself (see `server/mcp/session-runner.ts`'s `resolveBackend`
// doc comment and `docs/routing-and-quota.md`): false-positive triggers and
// stampede behavior under burst cost the owner more than the quota it saved. Only
// the reactive fallback remains, and `isQuotaError` is its regex layer.

import { describe, expect, test } from "bun:test";
import { isQuotaError } from "../server/mcp/session-runner.ts";

describe("isQuotaError", () => {
  test("recognizes Max/gateway quota and rate-limit language", () => {
    expect(isQuotaError("You've hit your usage limit for the next few hours.")).toBe(true);
    expect(isQuotaError("hit your limit")).toBe(true);
    expect(isQuotaError("rate_limit_error: too many requests")).toBe(true);
    // Mutation target: dropping the bare "429" alternative from QUOTA_ERROR_RE
    // makes this one fail while the others stay green.
    expect(isQuotaError("Session exited with code 1. stderr: 429 Too Many Requests")).toBe(true);
    expect(isQuotaError("Overloaded")).toBe(true);
    expect(isQuotaError("daily quota exceeded")).toBe(true);
  });

  test("does not mistake unrelated text containing the word 'limit' for a quota error", () => {
    expect(isQuotaError("lint step failed: limit 40 files exceeded per run")).toBe(false);
    expect(isQuotaError("zod validation failed")).toBe(false);
    expect(isQuotaError("Session exited with code 137")).toBe(false);
  });
});
