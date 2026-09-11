// The worker's CLI argument vector. Several of these flags are the only thing standing
// between a worker session and the machine it runs on, and their absence is invisible at
// runtime — a missing `--disallowedTools` produced a read-only tool that could write for
// months, and a missing `--settings` lets an audited repo run commands as this user. Both
// were found by probing the real CLI, not by reading it; these tests are what keeps them
// from silently going away again.

import { describe, expect, test } from "bun:test";
import { buildSessionArgs, buildWorkerEnv, WORKER_SETTINGS } from "../server/mcp/session-runner.ts";

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

  test("ignores every MCP server the repo might define, by default", () => {
    const a = args();
    expect(a).toContain("--strict-mcp-config");
    expect(valueOf(a, "--mcp-config")).toBe('{"mcpServers": {}}');
  });

  test("injects an explicit mcpServers set when the caller passes one", () => {
    const a = args({
      mcpServers: { hyperdx: { type: "http", url: "http://x/api/mcp", headers: {} } },
    });
    expect(a).toContain("--strict-mcp-config");
    expect(JSON.parse(valueOf(a, "--mcp-config") ?? "{}")).toEqual({
      mcpServers: { hyperdx: { type: "http", url: "http://x/api/mcp", headers: {} } },
    });
  });

  test("read-only removes the editing tools by DISallowing them", () => {
    const a = args({ readOnly: true });
    expect(valueOf(a, "--disallowedTools")).toBe("Write,Edit,NotebookEdit");
    // `--allowedTools` restricts nothing under --dangerously-skip-permissions; it was the
    // original, silently-broken spelling. It must never come back.
    expect(a).not.toContain("--allowedTools");
  });

  test("extraDisallowedTools appends to, never replaces, the base read-only list", () => {
    const a = args({
      readOnly: true,
      extraDisallowedTools: [
        "mcp__hyperdx__clickstack_save_dashboard",
        "mcp__hyperdx__clickstack_delete_dashboard",
      ],
    });
    expect(valueOf(a, "--disallowedTools")).toBe(
      "Write,Edit,NotebookEdit,mcp__hyperdx__clickstack_save_dashboard,mcp__hyperdx__clickstack_delete_dashboard",
    );
  });

  test("extraDisallowedTools is a no-op on a writable session", () => {
    const a = args({
      readOnly: false,
      extraDisallowedTools: ["mcp__hyperdx__clickstack_save_dashboard"],
    });
    expect(a).not.toContain("--disallowedTools");
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

// ── buildWorkerEnv — USAGE_LANE ──────────────────────────────────────────────────
//
// USAGE_LANE tags a worker's cost to its routed tool for usage-tracker's claude-code
// collector. It must survive `buildWorkerEnv`'s own sensitive-env scrub (the same pass that
// deletes any inherited TOKEN/SECRET/KEY-shaped var) — `USAGE_LANE` doesn't match that
// pattern today, but this pins the behavior rather than trusting the regex by inspection.

function workerEnv(overrides: Partial<Parameters<typeof buildWorkerEnv>[0]> = {}) {
  return buildWorkerEnv({
    backend: "max",
    model: "claude-sonnet-5",
    anthropicBase: "",
    iuKey: "",
    baseEnv: {},
    ...overrides,
  });
}

describe("buildWorkerEnv — USAGE_LANE", () => {
  test("pins sideclaw:<tool> for a defined tool", () => {
    expect(workerEnv({ tool: "review" }).USAGE_LANE).toBe("sideclaw:review");
  });

  test("defaults to sideclaw:unknown when no tool is given", () => {
    expect(workerEnv({ tool: undefined }).USAGE_LANE).toBe("sideclaw:unknown");
  });

  test("survives the sensitive-env scrub that follows", () => {
    // A worker env carrying credential-shaped inherited vars must have them scrubbed —
    // but USAGE_LANE, set just before the scrub runs, must still be standing after it.
    const env = workerEnv({
      tool: "dispatch",
      baseEnv: {
        GITHUB_TOKEN: "ghp_x",
        SOME_API_KEY: "secret",
        SESSION_ID: "should-be-scrubbed",
        HOME: "/Users/example",
      },
    });
    expect(env.USAGE_LANE).toBe("sideclaw:dispatch");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SOME_API_KEY).toBeUndefined();
    expect(env.SESSION_ID).toBeUndefined();
    expect(env.HOME).toBe("/Users/example");
  });
});
