// runSession's retry loop (server/mcp/session-runner.ts) checked ONLY isCancelled after a
// failed attempt, missing the window between that check and the next attempt's spawn — a cancel
// landing during the retry backoff sleep found nothing to SIGTERM (the previous proc already
// exited and left activeProcs, the next doesn't exist yet) and the next attempt launched
// anyway, silently overriding a `POST /api/jobs/:id/cancel`. Pins the fix: the predicate is
// checked at the TOP of every loop iteration too, via `__setAttemptRunnerForTests` so the loop's
// own timing (not a real `claude -p` subprocess) drives the assertion.

import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetAttemptRunnerForTests,
  __setAttemptRunnerForTests,
  runSession,
  SessionCancelledError,
  type SessionOptions,
  type SessionResult,
} from "../server/mcp/session-runner.ts";
import type { ToolRoute } from "../server/lib/routing.ts";

afterEach(() => {
  __resetAttemptRunnerForTests();
});

const ROUTE: ToolRoute = {
  model: "glm-5.3-flash",
  backend: "iu",
  fallback: null, // no lane switch available — planNextAttempt can only "retry" or "return"
  transport: "session",
};

describe("runSession's cancel check at the top of the retry loop", () => {
  test("a cancel arriving between a failed (retryable) attempt and the next spawn aborts before that spawn — the attempt runner is called exactly once", async () => {
    let attemptCalls = 0;
    // false for the first two checks (top-of-loop before attempt 1, and the post-failure check
    // right after it) — true from the third call onward, modeling a cancel landing strictly
    // during the retry backoff sleep, before the loop's next top-of-loop check.
    let predicateCalls = 0;
    const isCancelled = () => {
      predicateCalls++;
      return predicateCalls >= 3;
    };

    __setAttemptRunnerForTests(
      async <T>(
        _opts: SessionOptions<T>,
        turnsRef: { current: number },
      ): Promise<SessionResult<T>> => {
        attemptCalls++;
        turnsRef.current = 0; // no output yet — required for planNextAttempt to consider a retry
        return { ok: false, error: "503 Service Unavailable", backend: "iu", model: ROUTE.model };
      },
    );

    const opts: SessionOptions<unknown> = {
      cwd: "/tmp",
      prompt: "irrelevant — attemptRunner is faked",
      route: ROUTE,
      tool: "check",
      jobId: "job-under-test",
      isCancelled,
    };

    await expect(runSession(opts)).rejects.toThrow(SessionCancelledError);
    // The retry backoff (retryBackoffMs(1) = 1000ms real sleep) elapsed once, and the second
    // attempt was never launched — proving the top-of-loop check, not just the post-failure one,
    // is what caught it.
    expect(attemptCalls).toBe(1);
  }, 10_000);

  test("with no cancel ever requested, the same retryable failure DOES retry (attempt runner called twice)", async () => {
    let attemptCalls = 0;
    __setAttemptRunnerForTests(
      async <T>(
        _opts: SessionOptions<T>,
        turnsRef: { current: number },
      ): Promise<SessionResult<T>> => {
        attemptCalls++;
        turnsRef.current = 0;
        if (attemptCalls === 1) {
          return { ok: false, error: "503 Service Unavailable", backend: "iu", model: ROUTE.model };
        }
        return { ok: true, data: { fine: true } as T, backend: "iu", model: ROUTE.model };
      },
    );

    const opts: SessionOptions<{ fine: boolean }> = {
      cwd: "/tmp",
      prompt: "irrelevant",
      route: ROUTE,
      tool: "check",
      jobId: "job-under-test-2",
      isCancelled: () => false,
    };

    const result = await runSession(opts);
    expect(result.ok).toBe(true);
    expect(attemptCalls).toBe(2);
  }, 10_000);
});
