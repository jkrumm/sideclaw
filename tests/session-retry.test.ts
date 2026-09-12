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
  classifyExitFailure,
  unclassifiedOutputFailure,
  backendFallbacksLastHour,
  recordFallback,
  isIuNeverAnswered,
  recordRouteOutcome,
  routeFailureStreaks,
  ROUTE_STREAK_LIMIT,
  ROUTE_STREAK_MAX_KEYS,
  __resetRouteStreaksForTests,
  isIdleTimedOut,
  IDLE_TIMEOUT_MS,
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
  test("full jitter — each delay is in [0, min(cap, base * factor^(attempt-1))]", () => {
    for (let i = 0; i < 50; i++) {
      const attempt1 = retryBackoffMs(1);
      expect(attempt1).toBeGreaterThanOrEqual(0);
      expect(attempt1).toBeLessThanOrEqual(2000);
      const attempt2 = retryBackoffMs(2);
      expect(attempt2).toBeGreaterThanOrEqual(0);
      expect(attempt2).toBeLessThanOrEqual(6000);
    }
  });

  test("caps at 30s regardless of how far the exponent would otherwise grow", () => {
    expect(retryBackoffMs(10)).toBeLessThanOrEqual(30_000);
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

  test("iu exit-1 on a 403 cost-denial with no output → immediate fallback to max at attempt 1", () => {
    const cost403 =
      'Session exited with code 1. stderr: {"error":"access_denied","message":"rolling-30-day-cost-service-denial-limit"}';
    const plan = planNextAttempt({
      ...base,
      result: {
        ok: false,
        backend: "iu",
        error: cost403,
        classificationText: cost403,
      },
      fallback: iuToHaiku,
    });
    expect(plan).toEqual({
      kind: "fallback",
      forced: { backend: "max", model: "claude-haiku-4-5", reason: "iu-unavailable" },
    });
  });

  test("the same 403 text WITH output already produced does not fall back — the worker may have started writing files", () => {
    const cost403 =
      'Session exited with code 1. stderr: {"error":"access_denied","message":"rolling-30-day-cost-service-denial-limit"}';
    const plan = planNextAttempt({
      ...base,
      noOutputYet: false,
      result: {
        ok: false,
        backend: "iu",
        error: cost403,
        classificationText: cost403,
      },
      fallback: iuToHaiku,
    });
    expect(plan).toEqual({ kind: "return" });
  });

  test("unrecognized_model on an ok:true result is never consulted — a successful attempt always returns", () => {
    const plan = planNextAttempt({
      ...base,
      result: {
        ok: true,
        backend: "iu",
        classificationText:
          '[claude-code:unrecognized_model] {"model":"glm-5.3-flash","query_source":"generate_session_title"}',
      },
      fallback: iuToHaiku,
    });
    expect(plan).toEqual({ kind: "return" });
  });

  test("the same 403 text on a MAX-backend failure is unchanged — isIuNeverAnswered only gates the iu→max lane", () => {
    const cost403 = 'stderr: {"error":"access_denied","message":"cost-service-denial-limit"}';
    const plan = planNextAttempt({
      ...base,
      result: { ok: false, backend: "max", error: cost403, classificationText: cost403 },
      fallback: maxToIu,
    });
    expect(plan).toEqual({ kind: "return" });
  });

  // Measured 2026-09-10, job c4f0f631 (`--model glm-x`, reproduced by hand): a gateway
  // refusal is NOT zero-turn — one synthetic assistant "turn" (Claude Code's own error
  // rendering) plus a `result` event carrying `api_error_status` — so `noOutputYet` is
  // false (`turns: 1`) and the text-only `isIuNeverAnswered` gate above never applies.
  // `apiErrorStatus` is the fix: it must fall back on its own, `noOutputYet` or not.
  test("apiErrorStatus 403 on iu, ONE turn already observed (noOutputYet: false) → still falls back to max at attempt 1", () => {
    const plan = planNextAttempt({
      ...base,
      noOutputYet: false,
      result: {
        ok: false,
        backend: "iu",
        error: "Session exited with code 1. stderr: [claude-code:unrecognized_model] …",
        apiErrorStatus: 403,
      },
      fallback: iuToHaiku,
    });
    expect(plan).toEqual({
      kind: "fallback",
      forced: { backend: "max", model: "claude-haiku-4-5", reason: "iu-unavailable" },
    });
  });

  test("apiErrorStatus 404 (the reproduced --model glm-x case, in the closed GATEWAY_REFUSED_STATUSES set) on iu → falls back to max the same way", () => {
    const plan = planNextAttempt({
      ...base,
      noOutputYet: false,
      result: {
        ok: false,
        backend: "iu",
        error: "Session exited with code 1. stderr: [claude-code:unrecognized_model] …",
        apiErrorStatus: 404,
      },
      fallback: iuToHaiku,
    });
    expect(plan).toEqual({
      kind: "fallback",
      forced: { backend: "max", model: "claude-haiku-4-5", reason: "iu-unavailable" },
    });
  });

  test("apiErrorStatus 503 on iu attempt 1 with no output → retry, not fallback — 503 is the existing retry ladder's territory, not in the closed gateway-refused set", () => {
    const plan = planNextAttempt({
      ...base,
      result: {
        ok: false,
        backend: "iu",
        error: "Session exited with code 1. stderr: 503 Service Unavailable",
        apiErrorStatus: 503,
      },
      fallback: iuToHaiku,
    });
    expect(plan).toEqual({ kind: "retry" });
  });

  test("apiErrorStatus on a MAX-backend failure is unchanged — that lane is quota-only, gatewayRefused does not feed it", () => {
    const plan = planNextAttempt({
      ...base,
      noOutputYet: false,
      result: {
        ok: false,
        backend: "max",
        error: "Session exited with code 1. stderr: [claude-code:unrecognized_model] …",
        apiErrorStatus: 403,
      },
      fallback: maxToIu,
    });
    expect(plan).toEqual({ kind: "return" });
  });

  test("gatewayRefused on the LAST attempt still returns — isLastAttempt wins over any switch", () => {
    const plan = planNextAttempt({
      ...base,
      attempt: MAX_SESSION_ATTEMPTS,
      noOutputYet: false,
      result: {
        ok: false,
        backend: "iu",
        error: "Session exited with code 1. stderr: [claude-code:unrecognized_model] …",
        apiErrorStatus: 403,
      },
      fallback: iuToHaiku,
    });
    expect(plan).toEqual({ kind: "return" });
  });

  test("a zero-output iu failure carrying the (now-excluded) CLI warning banners retries the same backend instead of jumping straight to fallback — the banners print on an ordinary transport failure's stderr too, which is exactly why they were dropped from IU_NEVER_ANSWERED_RE", () => {
    const text =
      'Session exited with code 1. stderr: ⚠ claude.ai connectors are disabled for this account [claude-code:unrecognized_model] {"model":"glm-5.3-flash","query_source":"generate_session_title"} 502 Bad Gateway';
    const plan = planNextAttempt({
      ...base,
      result: { ok: false, backend: "iu", error: text, classificationText: text },
      fallback: iuToHaiku,
    });
    expect(plan).toEqual({ kind: "retry" });
  });
});

describe("isIuNeverAnswered", () => {
  test("matches the gateway's own cost-ceiling refusal", () => {
    expect(isIuNeverAnswered('{"error":"access_denied","reason":"cost-service-denial"}')).toBe(
      true,
    );
    expect(isIuNeverAnswered("403 Forbidden")).toBe(true);
  });

  test("does NOT match the two Claude Code CLI warning lines — dropped 2026-09-10: they print on every IU run (including success) AND on an ordinary zero-output transport failure, so matching them skipped the documented same-backend retry on a plain 502/ECONNRESET", () => {
    expect(isIuNeverAnswered('[claude-code:unrecognized_model] {"model":"glm-5.3-flash"}')).toBe(
      false,
    );
    expect(isIuNeverAnswered("⚠ claude.ai connectors are disabled for this account")).toBe(false);
  });

  test("does not match unrelated text", () => {
    expect(isIuNeverAnswered("Session timed out after 240000ms")).toBe(false);
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

// ── classifyExitFailure — the exitCode !== 0 branch of runSessionAttempt ────────────
//
// Regression coverage for job e7fd9175-…: an investigate-tier session hit its 25-turn
// ceiling, the CLI exited 1 with a `result` envelope carrying `subtype: "error_max_turns"`,
// and the runner used to report only "Session exited with code 1. stderr: …", burying the
// real cause under the CLI's own benign `unrecognized_model` stderr noise and never
// signaling `noOutput` so `isSalvageable` could retry it.

describe("classifyExitFailure", () => {
  test("an envelope with error_max_turns wins over stderr and sets noOutput", () => {
    const r = classifyExitFailure(
      1,
      { subtype: "error_max_turns" },
      '[claude-code:unrecognized_model] {"model":"glm-5.3-flash","query_source":"generate_session_title"}',
      "",
    );
    expect(r.error).toContain("error_max_turns");
    expect(r.error).not.toContain("unrecognized_model");
    expect(r.noOutput).toBe(true);
  });

  test("an envelope with error_max_structured_output_retries also sets noOutput", () => {
    const r = classifyExitFailure(1, { subtype: "error_max_structured_output_retries" }, "", "");
    expect(r.error).toContain("error_max_structured_output_retries");
    expect(r.noOutput).toBe(true);
  });

  test("a benign-only stderr line is stripped, leaving no noise in the error", () => {
    const r = classifyExitFailure(
      1,
      undefined,
      '[claude-code:unrecognized_model] {"model":"glm-5.3-flash","query_source":"generate_session_title"}',
      "",
    );
    expect(r.error).toBe("Session exited with code 1");
    expect(r.noOutput).toBe(false);
  });

  test("no envelope but real stderr: the real text survives stripping", () => {
    const r = classifyExitFailure(1, undefined, "fetch failed: ECONNRESET", "");
    expect(r.error).toBe("Session exited with code 1. stderr: fetch failed: ECONNRESET");
  });

  test("no envelope, no stderr, but the worker left assistant text: noOutput signals salvageable", () => {
    const r = classifyExitFailure(1, undefined, "", "here is what I found before exiting");
    expect(r.error).toBe("Session exited with code 1");
    expect(r.noOutput).toBe(true);
  });

  test("no envelope, no stderr, no assistant text at all: not salvageable", () => {
    const r = classifyExitFailure(1, undefined, "", "");
    expect(r.noOutput).toBe(false);
  });

  test("an envelope's own errors[]/result text is appended as detail", () => {
    const r = classifyExitFailure(1, { errors: ["boom"] }, "", "");
    expect(r.error).toBe("Session exited with code 1 (unknown): boom");
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

describe("recordRouteOutcome / routeFailureStreaks", () => {
  test("three consecutive failures then a success: the streak climbs, hits the limit, then resets to 0 (dropped from the report)", () => {
    const tool = "check-streak-a";
    recordRouteOutcome(tool, "iu", "glm-5.3-flash", false);
    recordRouteOutcome(tool, "iu", "glm-5.3-flash", false);
    recordRouteOutcome(tool, "iu", "glm-5.3-flash", false);
    const key = `${tool}@iu/glm-5.3-flash`;
    expect(routeFailureStreaks()[key]).toBe(3);
    expect(ROUTE_STREAK_LIMIT).toBe(3);
    recordRouteOutcome(tool, "iu", "glm-5.3-flash", true);
    expect(routeFailureStreaks()[key]).toBeUndefined();
  });

  test("keys are per route — a fallback attempt's own backend/model never shares a streak with the primary's", () => {
    const tool = "check-streak-b";
    recordRouteOutcome(tool, "iu", "glm-5.3-flash", false);
    recordRouteOutcome(tool, "max", "claude-haiku-4-5", false);
    const streaks = routeFailureStreaks();
    expect(streaks[`${tool}@iu/glm-5.3-flash`]).toBe(1);
    expect(streaks[`${tool}@max/claude-haiku-4-5`]).toBe(1);
  });

  test("routeFailureStreaks() reports only non-zero streaks", () => {
    const tool = "check-streak-c";
    recordRouteOutcome(tool, "iu", "glm-5.3-flash", true);
    expect(routeFailureStreaks()[`${tool}@iu/glm-5.3-flash`]).toBeUndefined();
  });

  test("the map is bounded at ROUTE_STREAK_MAX_KEYS — a caller-controlled model string (e.g. narrative's params.model) cannot grow it forever", () => {
    // `routeStreaks` is process-global module state shared with every other test in this
    // file — reset to a known-empty map first so "size stays 64" is an exact assertion,
    // not a guess about what earlier tests left behind.
    __resetRouteStreaksForTests();
    try {
      expect(ROUTE_STREAK_MAX_KEYS).toBe(64);
      const keys = Array.from({ length: 65 }, (_, i) => `bound-probe-${i}`);
      for (const tool of keys) recordRouteOutcome(tool, "iu", "glm-5.3-flash", false);

      const streaks = routeFailureStreaks();
      expect(Object.keys(streaks).length).toBe(ROUTE_STREAK_MAX_KEYS);
      // Oldest-first eviction: the very first key inserted is the one that falls out
      // once the 65th insertion pushes the map past capacity.
      expect(streaks[`${keys[0]}@iu/glm-5.3-flash`]).toBeUndefined();
      // The rest of the 65 survive except that one.
      expect(streaks[`${keys[64]}@iu/glm-5.3-flash`]).toBe(1);
      expect(streaks[`${keys[1]}@iu/glm-5.3-flash`]).toBe(1);
    } finally {
      __resetRouteStreaksForTests();
    }
  });
});

describe("isIdleTimedOut", () => {
  test("a session with steady stdout well past the old 60-minute ceiling is never flagged idle", () => {
    // Simulate a worker that emits a stdout chunk every 4 minutes (under IDLE_TIMEOUT_MS's
    // 5-minute budget) for 3 hours straight — three times the removed CEILING_FLOOR_MS. There
    // is no ceiling left to hit: as long as each gap stays under IDLE_TIMEOUT_MS, the watchdog
    // must never fire, no matter how long the session runs in total.
    const stepMs = 4 * 60 * 1000;
    const totalMs = 3 * 60 * 60 * 1000;
    let lastActivityAt = 0;
    for (let now = 0; now <= totalMs; now += stepMs) {
      expect(isIdleTimedOut(now, lastActivityAt)).toBe(false);
      lastActivityAt = now; // a stdout chunk just arrived, resetting the clock
    }
  });

  test("flags idle once the gap since the last chunk reaches IDLE_TIMEOUT_MS", () => {
    expect(isIdleTimedOut(IDLE_TIMEOUT_MS - 1, 0)).toBe(false);
    expect(isIdleTimedOut(IDLE_TIMEOUT_MS, 0)).toBe(true);
  });
});
