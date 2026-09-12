// Was: guards docs/deployment.md § Drain window sizing's coupling between
// `IMPLEMENT_SESSION_TIMEOUT_MS` and `TIERS.implement.timeoutMs` (`server/jobs/handlers/
// dispatch.ts`). That field no longer exists — 2026-09-12 removed every worker session's
// `maxTurns`/`timeoutMs`/absolute ceiling; the only liveness rule left is session-runner.ts's
// idle watchdog (no stdout for IDLE_TIMEOUT_MS), which has no upper bound on total wall-clock
// for a session that keeps producing output. `IMPLEMENT_SESSION_TIMEOUT_MS` is therefore now a
// standalone operational constant in `shutdown.ts` — not derived from, or required to match,
// any per-tier ceiling dispatch no longer configures. What still has to hold, and what this file
// now guards instead, is the internal relationship the drain-window math in `shutdown.ts` itself
// depends on: `HTTP_DRAIN_GRACE_MS` must cover more than `IMPLEMENT_SESSION_TIMEOUT_MS` alone
// (it adds the `depositBranch()` teardown margin on top).

import { describe, expect, test } from "bun:test";
import { HTTP_DRAIN_GRACE_MS, IMPLEMENT_SESSION_TIMEOUT_MS } from "../server/lib/shutdown.ts";

describe("shutdown drain-window sizing", () => {
  test("HTTP_DRAIN_GRACE_MS covers at least one full implement-session budget plus real margin", () => {
    expect(HTTP_DRAIN_GRACE_MS).toBeGreaterThan(IMPLEMENT_SESSION_TIMEOUT_MS);
  });
});
