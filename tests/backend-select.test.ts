// Dynamic Max→IU quota fallback: the pure decision (`chooseBackend`), the two
// quota-source parsers (`parseQuotaFile`/`parseQuotaApi`), and the failure-text
// classifier (`isQuotaError`) that gates the reactive retry in `runSession`.
// No subprocess, no mocks, no network — `resolveBackend` itself (which reads
// live quota) is exercised only for its IO-free short circuit, in
// tests/session-retry.test.ts.

import { describe, expect, test } from "bun:test";
import { chooseBackend, isQuotaError } from "../server/mcp/session-runner.ts";
import { parseQuotaApi, parseQuotaFile, type MaxQuota } from "../server/lib/quota.ts";

const CEILINGS = { ceilingFiveHour: 90, ceilingSevenDay: 95 };

function quota(overrides: Partial<MaxQuota> = {}): MaxQuota {
  return {
    fiveHourPct: 10,
    sevenDayPct: 14,
    fiveHourResetsAt: null,
    fetchedAt: Date.now(),
    source: "file",
    ...overrides,
  };
}

const UNKNOWN: MaxQuota = {
  fiveHourPct: null,
  sevenDayPct: null,
  fiveHourResetsAt: null,
  fetchedAt: null,
  source: "unknown",
};

describe("chooseBackend", () => {
  test("a non-Claude id always goes to iu, regardless of configured backend or quota", () => {
    expect(
      chooseBackend({
        configured: "max",
        model: "DeepSeek-V4-Flash",
        quota: quota({ fiveHourPct: 1, sevenDayPct: 1 }),
        fallback: "iu",
        ...CEILINGS,
      }),
    ).toEqual({ backend: "iu", reason: "non-claude-model" });

    expect(
      chooseBackend({
        configured: "iu",
        model: "glm-5.3-flash",
        quota: UNKNOWN,
        fallback: "iu",
        ...CEILINGS,
      }),
    ).toEqual({ backend: "iu", reason: "non-claude-model" });
  });

  test("fallback: none disables the check entirely — stays on configured even over ceiling", () => {
    const result = chooseBackend({
      configured: "max",
      model: "claude-sonnet-5[1m]",
      quota: quota({ fiveHourPct: 99, sevenDayPct: 99 }),
      fallback: "none",
      ...CEILINGS,
    });
    expect(result).toEqual({ backend: "max", reason: "fallback-disabled" });
  });

  test("unknown quota never blocks — stays on configured rather than guess", () => {
    const result = chooseBackend({
      configured: "max",
      model: "claude-sonnet-5[1m]",
      quota: UNKNOWN,
      fallback: "iu",
      ...CEILINGS,
    });
    expect(result).toEqual({ backend: "max", reason: "quota-unknown" });
  });

  test("healthy quota under both ceilings stays on configured", () => {
    const result = chooseBackend({
      configured: "max",
      model: "claude-sonnet-5[1m]",
      quota: quota({ fiveHourPct: 10, sevenDayPct: 14 }),
      fallback: "iu",
      ...CEILINGS,
    });
    expect(result).toEqual({ backend: "max", reason: "ok" });
  });

  test("five-hour ceiling: falls back at the boundary itself (>=), not only past it", () => {
    // Mutation target: flipping `>=` to `>` on the five-hour comparison in
    // chooseBackend makes this test fail (90 no longer trips it) while leaving
    // "healthy quota" above green — this is the boundary case that would slip
    // through.
    const atCeiling = chooseBackend({
      configured: "max",
      model: "claude-sonnet-5[1m]",
      quota: quota({ fiveHourPct: 90, sevenDayPct: 10 }),
      fallback: "iu",
      ...CEILINGS,
    });
    expect(atCeiling).toEqual({ backend: "iu", reason: "quota" });

    const justUnder = chooseBackend({
      configured: "max",
      model: "claude-sonnet-5[1m]",
      quota: quota({ fiveHourPct: 89, sevenDayPct: 10 }),
      fallback: "iu",
      ...CEILINGS,
    });
    expect(justUnder).toEqual({ backend: "max", reason: "ok" });
  });

  test("seven-day ceiling: falls back at the boundary itself (>=)", () => {
    const atCeiling = chooseBackend({
      configured: "max",
      model: "claude-sonnet-5[1m]",
      quota: quota({ fiveHourPct: 10, sevenDayPct: 95 }),
      fallback: "iu",
      ...CEILINGS,
    });
    expect(atCeiling).toEqual({ backend: "iu", reason: "quota" });

    const justUnder = chooseBackend({
      configured: "max",
      model: "claude-sonnet-5[1m]",
      quota: quota({ fiveHourPct: 10, sevenDayPct: 94 }),
      fallback: "iu",
      ...CEILINGS,
    });
    expect(justUnder).toEqual({ backend: "max", reason: "ok" });
  });

  test("either window alone is enough to trip the fallback", () => {
    expect(
      chooseBackend({
        configured: "max",
        model: "claude-sonnet-5[1m]",
        quota: quota({ fiveHourPct: 99, sevenDayPct: 1 }),
        fallback: "iu",
        ...CEILINGS,
      }).backend,
    ).toBe("iu");
    expect(
      chooseBackend({
        configured: "max",
        model: "claude-sonnet-5[1m]",
        quota: quota({ fiveHourPct: 1, sevenDayPct: 99 }),
        fallback: "iu",
        ...CEILINGS,
      }).backend,
    ).toBe("iu");
  });

  test("an iu-configured install is never pushed onto max by healthy quota", () => {
    // healthy-quota "else" branch returns `configured`, not a hardcoded "max" —
    // the fallback only ever moves max→iu, never the reverse.
    const result = chooseBackend({
      configured: "iu",
      model: "claude-sonnet-5[1m]",
      quota: quota({ fiveHourPct: 10, sevenDayPct: 14 }),
      fallback: "iu",
      ...CEILINGS,
    });
    expect(result).toEqual({ backend: "iu", reason: "ok" });
  });
});

describe("parseQuotaFile", () => {
  const now = 1_788_770_000_000; // ms, arbitrary fixed instant near the fixture below
  const fresh = {
    five_hour: { utilization: 10.0, resets_at_epoch: 1_788_784_200 },
    seven_day: { utilization: 14.0, resets_at_epoch: 1_788_969_600 },
    seven_day_sonnet: { utilization: null, resets_at_epoch: null },
    fetched_at: 1_788_769_534, // ~466s before `now`
  };

  test("a fresh file parses into a MaxQuota with source: file", () => {
    expect(parseQuotaFile(fresh, now, 600)).toEqual({
      fiveHourPct: 10,
      sevenDayPct: 14,
      fiveHourResetsAt: 1_788_784_200_000,
      fetchedAt: 1_788_769_534_000,
      source: "file",
    });
  });

  test("a file older than maxAgeS is rejected (null), not returned stale", () => {
    expect(parseQuotaFile(fresh, now, 400)).toBeNull();
  });

  test("malformed payloads (missing fetched_at, wrong shape, non-object) are rejected", () => {
    expect(parseQuotaFile({ five_hour: { utilization: 1 } }, now, 600)).toBeNull();
    expect(parseQuotaFile("not an object", now, 600)).toBeNull();
    expect(parseQuotaFile(null, now, 600)).toBeNull();
    expect(parseQuotaFile(42, now, 600)).toBeNull();
  });
});

describe("parseQuotaApi", () => {
  test("parses the live oauth/usage shape, converting ISO resets_at to epoch ms", () => {
    const result = parseQuotaApi({
      five_hour: { utilization: 22.5, resets_at: "2026-09-05T12:00:00Z" },
      seven_day: { utilization: 40, resets_at: "2026-09-08T00:00:00Z" },
    });
    expect(result?.fiveHourPct).toBe(22.5);
    expect(result?.sevenDayPct).toBe(40);
    expect(result?.fiveHourResetsAt).toBe(Date.parse("2026-09-05T12:00:00Z"));
    expect(result?.source).toBe("api");
    expect(typeof result?.fetchedAt).toBe("number");
  });

  test("missing/invalid resets_at yields null rather than throwing", () => {
    const result = parseQuotaApi({ five_hour: { utilization: 5, resets_at: "not-a-date" } });
    expect(result?.fiveHourResetsAt).toBeNull();
  });

  test("non-object input is rejected", () => {
    expect(parseQuotaApi(null)).toBeNull();
    expect(parseQuotaApi("nope")).toBeNull();
  });
});

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
