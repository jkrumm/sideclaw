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
import {
  isProviderLimitNotice,
  isQuotaError,
  isUpstreamLimitFailure,
} from "../server/mcp/session-runner.ts";

describe("isQuotaError", () => {
  test("recognizes Max/gateway quota and rate-limit language", () => {
    expect(isQuotaError("You've hit your usage limit for the next few hours.")).toBe(true);
    // Regression: the CLI's weekly notice (job fbda02ed, 2026-09-30) — the observed text,
    // verbatim — must classify. QUOTA_ERROR_RE previously matched only "hit your (usage )?limit".
    expect(isQuotaError("You've hit your weekly limit · resets 6pm (Europe/Berlin)")).toBe(true);
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

describe("isProviderLimitNotice", () => {
  test("matches the CLI's own terminal Max limit notice, leading whitespace included", () => {
    expect(isProviderLimitNotice("You've hit your weekly limit · resets 6pm (Europe/Berlin)")).toBe(
      true,
    );
    expect(isProviderLimitNotice("  You've hit your usage limit")).toBe(true);
  });

  test("only matches at the START — a worker's output that merely quotes the phrase is not a notice", () => {
    // The regression the anchor exists for: a review of sideclaw's own diff could carry
    // this phrase inside its JSON findings. That must never switch a healthy run onto iu.
    expect(
      isProviderLimitNotice('{"summary":"the notice \'You\'ve hit your weekly limit\' is new"}'),
    ).toBe(false);
    expect(isProviderLimitNotice("You have hit your weekly limit")).toBe(false);
    expect(isProviderLimitNotice("")).toBe(false);
  });
});

describe("isUpstreamLimitFailure", () => {
  test("true for any of the three signals — structured api_retry, quota-shaped transport text, or the CLI notice in rawText", () => {
    expect(isUpstreamLimitFailure({ hadApiRetry: true })).toBe(true);
    expect(
      isUpstreamLimitFailure({ classificationText: "rate_limit_error: too many requests" }),
    ).toBe(true);
    // The exact shape the review synthesis salvage sees: the constructed error says nothing,
    // and the limit notice lives only in rawText.
    expect(
      isUpstreamLimitFailure({
        classificationText: "Session exited with code 1 after a success result envelope",
        rawText: "You've hit your weekly limit · resets 6pm (Europe/Berlin)",
      }),
    ).toBe(true);
  });

  test("false when no signal is present — an ordinary synthesis parse failure stays a genuine needs-human", () => {
    expect(isUpstreamLimitFailure({})).toBe(false);
    expect(
      isUpstreamLimitFailure({
        classificationText: "Session exited with code 1 after a success result envelope",
        rawText: "Here is my review in prose, sorry for the JSON",
      }),
    ).toBe(false);
  });
});
