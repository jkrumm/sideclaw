// Pure retry-policy tests — no session is spawned. See session-runner.ts's
// "Retry policy" section for why turns-produced-output is checked outside this
// function rather than folded into it.

import { describe, expect, test } from "bun:test";
import { isRetryableSessionError, retryBackoffMs } from "../server/mcp/session-runner.ts";

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
