// The worker's CLI argument vector. Several of these flags are the only thing standing
// between a worker session and the machine it runs on, and their absence is invisible at
// runtime — a missing `--disallowedTools` produced a read-only tool that could write for
// months, and a missing `--settings` lets an audited repo run commands as this user. Both
// were found by probing the real CLI, not by reading it; these tests are what keeps them
// from silently going away again.

import { describe, expect, test } from "bun:test";
import { buildSessionArgs, WORKER_SETTINGS } from "../server/mcp/session-runner.ts";

function args(overrides: Partial<Parameters<typeof buildSessionArgs>[0]> = {}): string[] {
  return buildSessionArgs({
    prompt: "do the thing",
    settingSources: "user,project",
    maxTurns: 30,
    model: "claude-sonnet-5",
    readOnly: false,
    ...overrides,
  });
}

/** Value following a flag, or undefined if the flag is absent. */
function valueOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

describe("buildSessionArgs — the bounds", () => {
  test("disables repo-supplied hooks on every session", () => {
    // Measured on CLI 2.1.220: without this, a repo's .claude/settings.json runs commands at
    // SessionStart and on every Bash call, in a session the repo's own brief influences.
    expect(valueOf(args(), "--settings")).toBe(WORKER_SETTINGS);
    expect(JSON.parse(WORKER_SETTINGS)).toEqual({ disableAllHooks: true });
  });

  test("the hook kill is not conditional on tier, model or read-only-ness", () => {
    for (const o of [
      {},
      { readOnly: true },
      { settingSources: "project" },
      { model: "DeepSeek-V4-Flash" },
      { jsonSchema: { type: "object" } },
    ]) {
      expect(valueOf(args(o), "--settings")).toBe(WORKER_SETTINGS);
    }
  });

  test("ignores every MCP server the repo might define", () => {
    const a = args();
    expect(a).toContain("--strict-mcp-config");
    expect(valueOf(a, "--mcp-config")).toBe('{"mcpServers": {}}');
  });

  test("read-only removes the editing tools by DISallowing them", () => {
    const a = args({ readOnly: true });
    expect(valueOf(a, "--disallowedTools")).toBe("Write,Edit,NotebookEdit");
    // `--allowedTools` restricts nothing under --dangerously-skip-permissions; it was the
    // original, silently-broken spelling. It must never come back.
    expect(a).not.toContain("--allowedTools");
  });

  test("a writing session keeps the editing tools", () => {
    expect(args({ readOnly: false })).not.toContain("--disallowedTools");
  });

  test("no session ever gets the permission prompt back", () => {
    // Not a safety property — the opposite. It is stated here because the read-only and
    // hook bounds above are written on the assumption that it holds.
    expect(args()).toContain("--dangerously-skip-permissions");
  });
});

describe("buildSessionArgs — pass-through", () => {
  test("carries the caller's setting sources verbatim", () => {
    expect(valueOf(args({ settingSources: "project" }), "--setting-sources")).toBe("project");
    expect(valueOf(args({ settingSources: "user,project" }), "--setting-sources")).toBe(
      "user,project",
    );
  });

  test("carries prompt, model and turn budget", () => {
    const a = args({ prompt: "brief text", model: "claude-haiku-4-5", maxTurns: 7 });
    expect(valueOf(a, "-p")).toBe("brief text");
    expect(valueOf(a, "--model")).toBe("claude-haiku-4-5");
    expect(valueOf(a, "--max-turns")).toBe("7");
  });

  test("streams NDJSON so the job layer can track activity", () => {
    const a = args();
    expect(valueOf(a, "--output-format")).toBe("stream-json");
    expect(a).toContain("--verbose");
  });
});

describe("buildSessionArgs — json schema", () => {
  test("strips $schema, which the CLI validator rejects as an unresolvable $ref", () => {
    const a = args({
      jsonSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
    });
    const emitted = JSON.parse(valueOf(a, "--json-schema") ?? "{}") as Record<string, unknown>;
    expect(emitted).toEqual({ type: "object" });
    expect(emitted.$schema).toBeUndefined();
  });

  test("is omitted entirely when no schema is requested", () => {
    expect(args()).not.toContain("--json-schema");
  });
});
