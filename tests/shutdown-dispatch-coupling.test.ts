// Was: guards docs/deployment.md § Drain window sizing's coupling between
// `IMPLEMENT_SESSION_TIMEOUT_MS` and `TIERS.implement.timeoutMs` (`server/jobs/handlers/
// dispatch.ts`). That field no longer exists — 2026-09-12 removed every worker session's
// `maxTurns`/`timeoutMs`/absolute ceiling; the only liveness rule left is session-runner.ts's
// idle watchdog (no stdout for IDLE_TIMEOUT_MS), which has no upper bound on total wall-clock
// for a session that keeps producing output. `IMPLEMENT_SESSION_TIMEOUT_MS` itself was then
// deleted (same pass that made boot recovery resumable, `dispatchRecoveryStatusFor` in
// `server/jobs/store.ts`) — `HTTP_DRAIN_GRACE_MS` no longer derives from any per-tier budget at
// all. What this file now guards is the resulting fact: the self-initiated drain waits
// unconditionally, because a worker actually killed on top of it is now recoverable rather than
// a dead end.

import { describe, expect, test } from "bun:test";
import { HTTP_DRAIN_GRACE_MS } from "../server/lib/shutdown.ts";

describe("shutdown drain-window sizing", () => {
  test("HTTP_DRAIN_GRACE_MS is unbounded — the self-drain waits for running jobs with no wall-clock cap", () => {
    expect(HTTP_DRAIN_GRACE_MS).toBe(Infinity);
  });
});
