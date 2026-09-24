// Which CLI a session attempt actually spawns (server/mcp/session-runner.ts's
// `resolveHarness`) — the switch `runSessionAttempt` uses to delegate to
// opencode-runner.ts's `runOpencodeAttempt`. Covers the one invariant the design leans on: a
// forced (fallback) attempt NEVER runs opencode, since the `iu`→`max` reverse lane's model is
// always a Claude id (routing.ts's `usableFallback` refuses any fallback onto `max` that
// isn't).

import { describe, expect, test } from "bun:test";
import { resolveHarness } from "../server/mcp/session-runner.ts";
import { routeFor, type ToolRoute } from "../server/lib/routing.ts";

describe("resolveHarness", () => {
  test("a primary attempt on an opencode-harness route (dispatch) runs opencode", () => {
    expect(resolveHarness(routeFor("dispatch"))).toBe("opencode");
  });

  test("a primary attempt on a claude-harness route (review) runs claude", () => {
    expect(resolveHarness(routeFor("review"))).toBe("claude");
  });

  test("a forced fallback attempt off an opencode-harness route STILL runs claude", () => {
    expect(
      resolveHarness(routeFor("dispatch"), {
        backend: "max",
        model: "claude-sonnet-5[1m]",
        reason: "iu-unavailable",
      }),
    ).toBe("claude");
  });

  test("a forced fallback attempt off an already-claude route also runs claude", () => {
    expect(
      resolveHarness(routeFor("review"), {
        backend: "iu",
        model: "claude-sonnet-5[1m]",
        reason: "rate-limited",
      }),
    ).toBe("claude");
  });

  test("a hand-built route bypassing routing.ts's own normalization — a Claude model with harness opencode — still resolves claude", () => {
    // Defense in depth (I1, 2026-09-24): routing.ts's buildRoutingTable/withModel both
    // normalize this combination away at construction time, but resolveHarness must not
    // trust that every caller went through them.
    const hostileRoute: ToolRoute = {
      model: "claude-sonnet-5[1m]",
      backend: "iu",
      fallback: null,
      transport: "session",
      harness: "opencode",
    };
    expect(resolveHarness(hostileRoute)).toBe("claude");
  });
});
