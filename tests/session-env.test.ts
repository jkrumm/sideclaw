// The `session_env` sidecar record (server/mcp/session-runner.ts's `writeSessionEnv`) is the
// ONLY per-worker signal usage-tracker gets at all — every worker runs with
// `disableAllHooks: true`, so dotfiles' own SessionStart hook never fires inside one. `lane`
// and `harness` are what let usage-tracker attribute a row to `sideclaw:<tool>` and tell a
// `claude -p` run from an `opencode run` one. Tested via the pure `sessionEnvRecord` builder
// so this never touches the real `~/.claude/logs` directory.

import { describe, expect, test } from "bun:test";
import { sessionEnvRecord, usageLane } from "../server/mcp/session-runner.ts";

describe("sessionEnvRecord", () => {
  test("claude harness: base_url present, lane derived from tool, harness claude", () => {
    expect(
      sessionEnvRecord(
        "sess-1",
        "https://iu.example.com/anthropic",
        "claude-sonnet-5",
        "iu",
        "dispatch",
        "claude",
      ),
    ).toEqual({
      session: "sess-1",
      base_url: "https://iu.example.com/anthropic",
      model: "claude-sonnet-5",
      backend: "iu",
      lane: "sideclaw:dispatch",
      harness: "claude",
    });
  });

  test("max backend writes an explicit null base_url, not a missing one", () => {
    const r = sessionEnvRecord("sess-2", null, "claude-sonnet-5[1m]", "max", "review", "claude");
    expect(r.base_url).toBeNull();
    expect(r.backend).toBe("max");
    expect(r.harness).toBe("claude");
  });

  test("opencode harness: same shape, harness opencode, lane still derived from tool", () => {
    expect(
      sessionEnvRecord(
        "ses_abc123",
        "https://iu.example.com/openai/v1",
        "deepseek-v4.1-flash",
        "iu",
        "dispatch",
        "opencode",
      ),
    ).toEqual({
      session: "ses_abc123",
      base_url: "https://iu.example.com/openai/v1",
      model: "deepseek-v4.1-flash",
      backend: "iu",
      lane: "sideclaw:dispatch",
      harness: "opencode",
    });
  });

  test("an undefined tool still resolves a lane via usageLane's own default", () => {
    const r = sessionEnvRecord("sess-3", null, "m", "max", undefined, "claude");
    expect(r.lane).toBe(usageLane(undefined));
    expect(r.lane).toBe("sideclaw:unknown");
  });
});
