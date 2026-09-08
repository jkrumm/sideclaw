// Pure retry-policy tests — no session is spawned. See session-runner.ts's
// "Retry policy" section for why turns-produced-output is checked outside this
// function rather than folded into it.

import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import {
  isRetryableSessionError,
  retryBackoffMs,
  resolveBackend,
  gatewayContextTokens,
  classifyErrorEnvelope,
  unclassifiedOutputFailure,
  backendFallbacksLastHour,
  recordFallback,
} from "../server/mcp/session-runner.ts";

describe("isRetryableSessionError", () => {
  test("retries known transient gateway statuses", () => {
    expect(
      isRetryableSessionError("Session exited with code 1. stderr: 429 Too Many Requests"),
    ).toBe(true);
    expect(isRetryableSessionError("upstream error: 503 Service Unavailable")).toBe(true);
    expect(isRetryableSessionError("Bad Gateway (502)")).toBe(true);
    expect(isRetryableSessionError("504 Gateway Timeout")).toBe(true);
  });

  test("retries connection-level errors with no status code at all", () => {
    expect(isRetryableSessionError("fetch failed: ECONNRESET")).toBe(true);
  });

  test("never retries a deterministic client error", () => {
    expect(isRetryableSessionError("401 Unauthorized")).toBe(false);
    expect(isRetryableSessionError("400 Bad Request: invalid model id")).toBe(false);
  });

  test("does not mistake an unrelated 3-digit number for a status code", () => {
    expect(isRetryableSessionError("Session exited with code 137")).toBe(false);
  });
});

describe("retryBackoffMs", () => {
  test("backs off exponentially across the two retry gaps", () => {
    expect(retryBackoffMs(1)).toBe(1000);
    expect(retryBackoffMs(2)).toBe(3000);
  });

  test("a client error the IU gateway re-wrapped as its own 503 is not retried", () => {
    // Observed shape from the live gateway: the HTTP status is 503 but the real
    // failure is a deterministic bad request, so the leading 503 must not win.
    expect(
      isRetryableSessionError("503 [Requesty Global Anthropic API StatusCode: BadRequest]"),
    ).toBe(false);
    expect(
      isRetryableSessionError("503 [Requesty Global Anthropic API StatusCode: Unauthorized]"),
    ).toBe(false);
    // A genuine gateway-side 503 with no wrapped client status still retries.
    expect(isRetryableSessionError("503 Service Unavailable")).toBe(true);
  });
});

describe("resolveBackend", () => {
  // Pure and synchronous — no I/O at all since the proactive Max-quota pre-check was
  // removed 2026-09-08 (see the function's own doc comment). Its only remaining job is
  // the non-Claude-model safeguard, kept here as defense in depth for a hand-built
  // route that bypasses `buildRoutingTable`/`withModel` (as these fixtures do).
  test("a non-Claude id is forced onto iu — max only serves Anthropic models", () => {
    expect(
      resolveBackend({
        model: "DeepSeek-V4-Flash",
        backend: "max",
        fallback: null,
        transport: "session",
      }).backend,
    ).toBe("iu");
    expect(
      resolveBackend({
        model: "glm-5.3-flash",
        backend: "max",
        fallback: null,
        transport: "session",
      }).backend,
    ).toBe("iu");
  });

  test("an iu-routed Claude id stays on iu", () => {
    const r = resolveBackend({
      model: "claude-sonnet-5[1m]",
      backend: "iu",
      fallback: { backend: "max" },
      transport: "session",
    });
    expect(r).toEqual({ backend: "iu", reason: "ok" });
  });

  test("a max route with no iu fallback just stays on max — there is no proactive check to disable anymore", () => {
    const r = resolveBackend({
      model: "claude-sonnet-5[1m]",
      backend: "max",
      fallback: null,
      transport: "session",
    });
    expect(r).toEqual({ backend: "max", reason: "ok" });
  });
});

describe("gatewayContextTokens", () => {
  test("a measured 1M model gets its full window", () => {
    expect(gatewayContextTokens("glm-5.3-flash")).toBe(1_000_000);
    expect(gatewayContextTokens("DeepSeek-V4-Flash")).toBe(1_000_000);
  });

  test("a model with a smaller hard cap is not budgeted past it", () => {
    // A budget above the real window turns a clean auto-compact into a hard API
    // rejection mid-session — the reason 1M is not a blanket default.
    expect(gatewayContextTokens("kimi-k2.7-code")).toBe(262_144);
  });

  test("an unknown id falls back to the conservative 200k, never 1M", () => {
    expect(gatewayContextTokens("some-new-gateway-model")).toBe(200_000);
  });
});

// ── planNextAttempt — the two fallback lanes + the transient retry, as one pure decision ──

import { planNextAttempt, MAX_SESSION_ATTEMPTS } from "../server/mcp/session-runner.ts";

describe("planNextAttempt", () => {
  const base = {
    attempt: 1,
    noOutputYet: true,
    usedFallback: false,
    routeModel: "claude-sonnet-5[1m]",
  };
  const maxToIu = { backend: "iu" as const };
  const iuToHaiku = { backend: "max" as const, model: "claude-haiku-4-5" };
  const iuToSame = { backend: "max" as const };

  test("a successful attempt returns, whatever the route", () => {
    expect(
      planNextAttempt({ ...base, result: { ok: true, backend: "iu" }, fallback: iuToHaiku }),
    ).toEqual({ kind: "return" });
  });

  test("max + quota-flavoured failure before output → iu, same model", () => {
    // classificationText mirrors what runSessionAttempt actually populates from
    // transport-sourced text (stderr / the CLI's own error) — see the two tests below
    // for why the full `error` field alone must NOT be enough.
    const plan = planNextAttempt({
      ...base,
      result: {
        ok: false,
        backend: "max",
        error: "You've hit your usage limit",
        classificationText: "You've hit your usage limit",
      },
      fallback: maxToIu,
    });
    expect(plan).toEqual({
      kind: "fallback",
      forced: { backend: "iu", model: "claude-sonnet-5[1m]", reason: "rate-limited" },
    });
  });

  test("the quota lane wins over the transient retry for a bare 429 in classificationText", () => {
    const plan = planNextAttempt({
      ...base,
      result: { ok: false, backend: "max", error: "429", classificationText: "429" },
      fallback: maxToIu,
    });
    expect(plan.kind).toBe("fallback");
  });

  test("POINT 2 REGRESSION GUARD: quota-sounding MODEL OUTPUT in `error` alone must never trigger the paid iu fallback", () => {
    // A check/otel/review worker's own stdout (a diff, an otel trace dump) can
    // legitimately contain the word "quota" with no real exhaustion behind it. Only
    // `error` carries that text here — no `classificationText`, no `hadApiRetry` — so
    // this must return, not switch a run that would finish fine on max onto billed iu.
    // (No status code in the fixture text — this isolates the quota-classification
    // fix from `isRetryableSessionError`'s own separate, unrelated same-backend retry.)
    const plan = planNextAttempt({
      ...base,
      result: {
        ok: false,
        backend: "max",
        error:
          "result field is not valid JSON: ...bumped the customer's storage quota in this diff...",
      },
      fallback: maxToIu,
    });
    expect(plan).toEqual({ kind: "return" });
  });

  test("the structured api_retry signal alone (hadApiRetry, no matching classificationText) still triggers the fallback", () => {
    const plan = planNextAttempt({
      ...base,
      result: {
        ok: false,
        backend: "max",
        error: "session ended unexpectedly",
        classificationText: "session ended unexpectedly",
        hadApiRetry: true,
      },
      fallback: maxToIu,
    });
    expect(plan).toEqual({
      kind: "fallback",
      forced: { backend: "iu", model: "claude-sonnet-5[1m]", reason: "rate-limited" },
    });
  });

  test("iu transport failure: one same-backend retry first, then max on the fixed fallback model", () => {
    const result = { ok: false, backend: "iu" as const, error: "503 Service Unavailable" };
    expect(planNextAttempt({ ...base, result, fallback: iuToHaiku })).toEqual({ kind: "retry" });
    expect(planNextAttempt({ ...base, attempt: 2, result, fallback: iuToHaiku })).toEqual({
      kind: "fallback",
      forced: { backend: "max", model: "claude-haiku-4-5", reason: "iu-unavailable" },
    });
  });

  test("a same-model fallback runs the route's own model on max", () => {
    const plan = planNextAttempt({
      ...base,
      attempt: 2,
      result: { ok: false, backend: "iu", error: "fetch failed: ECONNRESET" },
      fallback: iuToSame,
    });
    expect(plan).toEqual({
      kind: "fallback",
      forced: { backend: "max", model: "claude-sonnet-5[1m]", reason: "iu-unavailable" },
    });
  });

  test("missing IU credentials skip the same-backend retry — nothing to retry", () => {
    const plan = planNextAttempt({
      ...base,
      result: { ok: false, backend: "iu", error: "IU key not found", iuConfigError: true },
      fallback: iuToHaiku,
    });
    expect(plan.kind).toBe("fallback");
    // …and with no fallback there is nothing to do but return: never a retry loop on a
    // credential that will not appear between attempts.
    expect(
      planNextAttempt({
        ...base,
        result: { ok: false, backend: "iu", error: "x", iuConfigError: true },
        fallback: null,
      }),
    ).toEqual({ kind: "return" });
  });

  test("a timeout with ZERO worker events on iu goes straight to max (the glm stall)", () => {
    const plan = planNextAttempt({
      ...base,
      result: { ok: false, backend: "iu", error: "Session timed out after 240000ms" },
      fallback: iuToHaiku,
    });
    expect(plan).toEqual({
      kind: "fallback",
      forced: { backend: "max", model: "claude-haiku-4-5", reason: "iu-unavailable" },
    });
  });

  test("a timeout AFTER output is neither retried nor switched by default — the work may be half done", () => {
    const plan = planNextAttempt({
      ...base,
      noOutputYet: false,
      result: { ok: false, backend: "iu", error: "Session timed out after 240000ms" },
      fallback: iuToHaiku,
    });
    expect(plan).toEqual({ kind: "return" });
  });

  test("retryAfterOutput: a side-effect-free worker's timeout AFTER output still goes to max (the glm stall after 2 turns)", () => {
    const plan = planNextAttempt({
      ...base,
      noOutputYet: false,
      retryAfterOutput: true,
      result: { ok: false, backend: "iu", error: "Session timed out after 240000ms" },
      fallback: iuToHaiku,
    });
    expect(plan).toEqual({
      kind: "fallback",
      forced: { backend: "max", model: "claude-haiku-4-5", reason: "iu-unavailable" },
    });
  });

  test("retryAfterOutput widens ONLY the timeout lane — a transport error after output still returns", () => {
    const plan = planNextAttempt({
      ...base,
      attempt: 2,
      noOutputYet: false,
      retryAfterOutput: true,
      result: { ok: false, backend: "iu", error: "503 Service Unavailable" },
      fallback: iuToHaiku,
    });
    expect(plan).toEqual({ kind: "return" });
  });

  test("MUTATION GUARD: a lane switch happens once — the fallback attempt's own failure returns", () => {
    const plan = planNextAttempt({
      ...base,
      attempt: 2,
      usedFallback: true,
      result: { ok: false, backend: "max", error: "rate limit" },
      fallback: maxToIu,
    });
    expect(plan).toEqual({ kind: "return" });
  });

  test("no declared fallback → transient errors only ever retry the same backend", () => {
    const result = { ok: false, backend: "iu" as const, error: "502 Bad Gateway" };
    expect(planNextAttempt({ ...base, attempt: 2, result, fallback: null })).toEqual({
      kind: "retry",
    });
    expect(
      planNextAttempt({ ...base, attempt: MAX_SESSION_ATTEMPTS, result, fallback: null }),
    ).toEqual({ kind: "return" });
  });

  test("a deterministic client error never retries or switches", () => {
    const plan = planNextAttempt({
      ...base,
      result: { ok: false, backend: "iu", error: "401 Unauthorized" },
      fallback: iuToHaiku,
    });
    expect(plan).toEqual({ kind: "return" });
  });
});

// ── classifyErrorEnvelope — the is_error/no-`errors`/zero-turn carve-out ────────────

describe("classifyErrorEnvelope", () => {
  test("a structured errors[] array always classifies, regardless of turns", () => {
    expect(classifyErrorEnvelope({ errors: ["usage limit reached"] }, 0)).toEqual({
      errMsg: "usage limit reached",
      classificationText: "usage limit reached",
    });
    expect(classifyErrorEnvelope({ errors: ["usage limit reached"] }, 5)).toEqual({
      errMsg: "usage limit reached",
      classificationText: "usage limit reached",
    });
  });

  test("no errors[], zero turns: result is classified — it cannot be model text since the model never ran", () => {
    const r = classifyErrorEnvelope({ result: "You've hit your usage limit for the day." }, 0);
    expect(r.errMsg).toBe("You've hit your usage limit for the day.");
    expect(r.classificationText).toBe("You've hit your usage limit for the day.");
  });

  test("no errors[], at least one turn: result is real model output and is NEVER classified", () => {
    const r = classifyErrorEnvelope(
      { result: "here is the diff you asked about quota handling" },
      3,
    );
    expect(r.errMsg).toBe("here is the diff you asked about quota handling");
    expect(r.classificationText).toBeUndefined();
  });

  test("no errors[] and no result at all: falls back to the generic message, never classified past zero turns", () => {
    expect(classifyErrorEnvelope({}, 2)).toEqual({
      errMsg: "Unknown error",
      classificationText: undefined,
    });
    // Zero turns with no result text either: classificationText is `undefined` itself
    // (there's nothing to classify), not a crash.
    expect(classifyErrorEnvelope({}, 0)).toEqual({
      errMsg: "Unknown error",
      classificationText: undefined,
    });
  });
});

// ── unclassifiedOutputFailure — hadApiRetry must survive the schema/parse branches ──

describe("unclassifiedOutputFailure", () => {
  test("propagates hadApiRetry through while classificationText stays unset", () => {
    expect(
      unclassifiedOutputFailure("bad output", "raw text", true, "max", "claude-sonnet-5[1m]"),
    ).toEqual({
      ok: false,
      error: "bad output",
      noOutput: true,
      rawText: "raw text",
      hadApiRetry: true,
      backend: "max",
      model: "claude-sonnet-5[1m]",
    });
  });

  test("hadApiRetry: false is preserved too, not dropped as falsy", () => {
    const r = unclassifiedOutputFailure("bad output", "raw text", false, "iu", "glm-5.3-flash");
    expect(r.hadApiRetry).toBe(false);
  });
});

// ── backendFallbacksLastHour / recordFallback — the 1-hour window and reason tally ──
//
// Each test picks a base time far from the others (>1h apart) so the window itself
// isolates tests from each other's recorded entries without needing to reset the
// module-private log.

describe("backendFallbacksLastHour / recordFallback", () => {
  afterAll(() => setSystemTime());

  test("aggregates fallbacks recorded within the window by reason", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    recordFallback("rate-limited", "review");
    recordFallback("rate-limited", "dispatch");
    recordFallback("iu-unavailable", "check");
    expect(backendFallbacksLastHour()).toEqual({
      count: 3,
      reasons: { "rate-limited": 2, "iu-unavailable": 1 },
    });
  });

  test("an entry older than the 1-hour window is excluded", () => {
    const t0 = new Date("2026-01-02T00:00:00Z").getTime();
    setSystemTime(t0);
    recordFallback("rate-limited", "review");
    setSystemTime(t0 + 60 * 60 * 1000 + 1); // just over an hour later
    expect(backendFallbacksLastHour()).toEqual({ count: 0, reasons: {} });
  });

  test("an entry exactly at the 1-hour boundary is still included", () => {
    const t0 = new Date("2026-01-03T00:00:00Z").getTime();
    setSystemTime(t0);
    recordFallback("rate-limited", "review");
    setSystemTime(t0 + 60 * 60 * 1000); // exactly one hour later
    expect(backendFallbacksLastHour().count).toBe(1);
  });
});
