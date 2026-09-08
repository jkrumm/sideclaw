// Guards the coupling docs/deployment.md § Drain window sizing describes: HTTP_DRAIN_GRACE_MS's
// 30-minute base is an independent literal in server/lib/shutdown.ts (kept independent so that
// file stays free of dispatch.ts's import graph — session-runner, octokit, routing — rather
// than importing it just for one number), not a live reference to the actual job timeout it's
// meant to bound. If TIERS.implement.timeoutMs ever changes without this literal moving with
// it, the drain window silently stops matching the reasoning documented alongside it — this
// test fails loudly instead, the same pattern tests/shutdown-window.test.ts uses for the
// signal-side window against launchd's measured ExitTimeOut cap.

import { describe, expect, test } from "bun:test";
import { TIERS } from "../server/jobs/handlers/dispatch.ts";
import { HTTP_DRAIN_GRACE_MS, IMPLEMENT_SESSION_TIMEOUT_MS } from "../server/lib/shutdown.ts";

describe("shutdown/dispatch timeout coupling", () => {
  test("IMPLEMENT_SESSION_TIMEOUT_MS matches dispatch's actual configured implement timeout", () => {
    expect(IMPLEMENT_SESSION_TIMEOUT_MS).toBe(TIERS.implement.timeoutMs);
  });

  test("HTTP_DRAIN_GRACE_MS covers at least one full implement session plus real margin", () => {
    expect(HTTP_DRAIN_GRACE_MS).toBeGreaterThan(TIERS.implement.timeoutMs);
  });
});
