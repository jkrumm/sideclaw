// Pure builders + the NDJSON event mapper for the OpenCode harness (server/mcp/opencode-runner.ts).
// `tests/fixtures/opencode-events.jsonl` is a trimmed excerpt of a REAL successful
// `opencode run --format json` stream, captured 2026-09-24 against `iu/deepseek-v4.1-flash` —
// see routing.ts's AGENT_OC comment for the episode this came from.
// `tests/fixtures/opencode-events-error.jsonl` is two REAL failing runs (a rejected apiKey, an
// unrecognized model id), captured the same day via `OPENCODE_CONFIG_CONTENT` with deliberately
// broken credentials/model — the exact NDJSON `type: "error"` shape B1 fixes against.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendJsonSchemaInstruction,
  buildOpencodeArgs,
  buildOpencodeConfig,
  buildOpencodeEnv,
  computeOpencodeCostUsd,
  dbLockRetryDelayMs,
  INITIAL_OPENCODE_ACCUM,
  isDbLockedFailure,
  OPENCODE_DECLARED_VARIANTS,
  OPENCODE_PERMISSION_KEYS,
  redactSecret,
  reduceOpencodeEvent,
  runOpencodeAttempt,
} from "../server/mcp/opencode-runner.ts";
import { routeFor } from "../server/lib/routing.ts";

function readFixture(name: string): unknown[] {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

describe("buildOpencodeArgs", () => {
  test("bare invocation — dir, model-as-iu/<model>, format json, -- before the prompt", () => {
    const argv = buildOpencodeArgs({
      bin: "/opt/homebrew/bin/opencode",
      cwd: "/tmp/wt-vps",
      model: "deepseek-v4.1-flash",
      prompt: "investigate the thing",
    });
    expect(argv).toEqual([
      "/opt/homebrew/bin/opencode",
      "run",
      "--dir",
      "/tmp/wt-vps",
      "-m",
      "iu/deepseek-v4.1-flash",
      "--format",
      "json",
      "--",
      "investigate the thing",
    ]);
  });

  test("a prompt that starts with a dash is still the message, not a flag — the -- guard", () => {
    // Measured live 2026-09-24: without `--`, opencode's own yargs CLI parses a leading-dash
    // message as an unknown flag, prints --help and exits 0 with no session ever starting.
    const argv = buildOpencodeArgs({
      bin: "opencode",
      cwd: "/tmp/wt",
      model: "deepseek-v4.1-flash",
      prompt: "-foo, do the thing",
    });
    const dashDashIndex = argv.indexOf("--");
    expect(dashDashIndex).toBeGreaterThan(-1);
    expect(argv[dashDashIndex + 1]).toBe("-foo, do the thing");
    expect(argv.at(-1)).toBe("-foo, do the thing");
  });

  test("variant is inserted before -- when present", () => {
    const argv = buildOpencodeArgs({
      bin: "opencode",
      cwd: "/tmp/wt",
      model: "deepseek-v4.1-flash",
      variant: "max",
      prompt: "p",
    });
    const i = argv.indexOf("--variant");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("max");
    expect(argv.indexOf("--")).toBeGreaterThan(i);
  });

  test("resumeSessionId emits --session <id>", () => {
    const argv = buildOpencodeArgs({
      bin: "opencode",
      cwd: "/tmp/wt",
      model: "deepseek-v4.1-flash",
      resumeSessionId: "ses_abc123",
      prompt: "continue",
    });
    const i = argv.indexOf("--session");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("ses_abc123");
  });

  test("no --pure anywhere in the vector — measured to hang", () => {
    const argv = buildOpencodeArgs({
      bin: "opencode",
      cwd: "/tmp/wt",
      model: "deepseek-v4.1-flash",
      variant: "high",
      resumeSessionId: "ses_x",
      prompt: "p",
    });
    expect(argv).not.toContain("--pure");
  });
});

describe("buildOpencodeConfig", () => {
  test("every declared permission key is set explicitly — none left on the default ask", () => {
    for (const readOnly of [true, false]) {
      const cfg = buildOpencodeConfig({ model: "deepseek-v4.1-flash", readOnly });
      const permission = cfg.permission as Record<string, unknown>;
      for (const key of OPENCODE_PERMISSION_KEYS) {
        expect(permission[key], `${key} (readOnly=${readOnly})`).toBeDefined();
        expect(["allow", "deny"]).toContain(permission[key] as string);
      }
      // No stray keys beyond the declared set either.
      expect(Object.keys(permission).toSorted()).toEqual([...OPENCODE_PERMISSION_KEYS].toSorted());
    }
  });

  test("readOnly denies edit only — bash and everything else stays allowed, same parity as claude's disallowedTools", () => {
    const cfg = buildOpencodeConfig({ model: "deepseek-v4.1-flash", readOnly: true });
    const permission = cfg.permission as Record<string, string>;
    expect(permission.edit).toBe("deny");
    expect(permission.bash).toBe("allow");
  });

  test("writable session allows edit", () => {
    const cfg = buildOpencodeConfig({ model: "deepseek-v4.1-flash", readOnly: false });
    expect((cfg.permission as Record<string, string>).edit).toBe("allow");
  });

  test("external_directory and question are always deny, doom_loop always allow", () => {
    for (const readOnly of [true, false]) {
      const permission = buildOpencodeConfig({ model: "deepseek-v4.1-flash", readOnly })
        .permission as Record<string, string>;
      expect(permission.external_directory).toBe("deny");
      expect(permission.question).toBe("deny");
      expect(permission.doom_loop).toBe("allow");
    }
  });

  test("provider options reference the env-injected key/base, never a literal", () => {
    const cfg = buildOpencodeConfig({ model: "deepseek-v4.1-flash", readOnly: false });
    const provider = (cfg.provider as Record<string, unknown>).iu as Record<string, unknown>;
    expect(provider.options).toEqual({
      baseURL: "{env:IU_OPENAI_BASE}",
      apiKey: "{env:IU_KEY}",
    });
  });

  test("declares high, max and none as named variants — matching every variant AGENT_OC/AGENT_OC_IMPLEMENT actually pass", () => {
    const cfg = buildOpencodeConfig({ model: "deepseek-v4.1-flash", readOnly: false });
    const provider = (cfg.provider as Record<string, unknown>).iu as Record<string, unknown>;
    const models = provider.models as Record<string, unknown>;
    const modelEntry = models["deepseek-v4.1-flash"] as Record<string, unknown>;
    expect(modelEntry.cost).toEqual({ input: 0.15, output: 0.6, cache_read: 0.003 });
    expect(modelEntry.variants).toEqual({
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
      none: { reasoningEffort: "none" },
    });
    expect(Object.keys(modelEntry.variants as object).toSorted()).toEqual(
      [...OPENCODE_DECLARED_VARIANTS].toSorted(),
    );
  });
});

describe("buildOpencodeEnv", () => {
  test("IU_KEY/IU_OPENAI_BASE/OPENCODE_CONFIG_CONTENT are set, OPENCODE_CONFIG is never set", () => {
    const env = buildOpencodeEnv({
      tool: "dispatch",
      iuKey: "sk-secret-123",
      iuOpenaiBase: "https://iu.example.com/openai/v1",
      opencodeConfigContent: '{"permission":{}}',
      baseEnv: { PATH: "/usr/bin" },
    });
    expect(env.IU_KEY).toBe("sk-secret-123");
    expect(env.IU_OPENAI_BASE).toBe("https://iu.example.com/openai/v1");
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"permission":{}}');
    expect(env.OPENCODE_CONFIG).toBeUndefined();
  });

  test("an inherited OPENCODE_CONFIG file-path var is deleted, not merely shadowed", () => {
    const env = buildOpencodeEnv({
      tool: "dispatch",
      iuKey: "k",
      iuOpenaiBase: "https://iu.example.com/openai/v1",
      opencodeConfigContent: "{}",
      baseEnv: { OPENCODE_CONFIG: "/some/inherited/path.json" },
    });
    expect(env.OPENCODE_CONFIG).toBeUndefined();
  });

  test("the key never appears verbatim in any other env value", () => {
    const env = buildOpencodeEnv({
      tool: "dispatch",
      iuKey: "sk-secret-123",
      iuOpenaiBase: "https://iu.example.com/openai/v1",
      opencodeConfigContent: '{"permission":{}}',
      baseEnv: { PATH: "/usr/bin" },
    });
    const others = Object.entries(env).filter(([k]) => k !== "IU_KEY");
    expect(others.some(([, v]) => v === "sk-secret-123")).toBe(false);
  });

  test("scrub removes credential-shaped inherited env vars", () => {
    const env = buildOpencodeEnv({
      tool: "dispatch",
      iuKey: "k",
      iuOpenaiBase: "https://iu.example.com/openai/v1",
      opencodeConfigContent: "{}",
      baseEnv: { GITHUB_TOKEN: "ghp_leaked", SOME_API_KEY: "leaked2", PATH: "/usr/bin" },
    });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SOME_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  test("USAGE_LANE tags the tool, CLAUDE_SESSION_ID/CLAUDE_PARENT_SESSION_ID are stripped", () => {
    const env = buildOpencodeEnv({
      tool: "dispatch",
      iuKey: "k",
      iuOpenaiBase: "https://iu.example.com/openai/v1",
      opencodeConfigContent: "{}",
      baseEnv: { CLAUDE_SESSION_ID: "leftover", CLAUDE_PARENT_SESSION_ID: "leftover2" },
    });
    expect(env.USAGE_LANE).toBe("sideclaw:dispatch");
    expect(env.CLAUDE_ENTRYPOINT).toBe("worker");
    expect(env.CLAUDE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_PARENT_SESSION_ID).toBeUndefined();
  });

  test("extraEnv is applied last and wins over everything else", () => {
    const env = buildOpencodeEnv({
      tool: "dispatch",
      iuKey: "k",
      iuOpenaiBase: "https://iu.example.com/openai/v1",
      opencodeConfigContent: "{}",
      extraEnv: { IU_KEY: "overridden", GIT_CONFIG_COUNT: "1" },
      baseEnv: {},
    });
    expect(env.IU_KEY).toBe("overridden");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
  });
});

describe("appendJsonSchemaInstruction", () => {
  test("appends the prompt and the schema, final-message-only instruction present", () => {
    const out = appendJsonSchemaInstruction("do the thing", { type: "object", properties: {} });
    expect(out.startsWith("do the thing")).toBe(true);
    expect(out).toContain("FINAL message must be ONLY a single JSON object");
    expect(out).toContain('"type": "object"');
  });
});

describe("redactSecret", () => {
  test("replaces every occurrence with a fixed placeholder", () => {
    expect(redactSecret("key=sk-abc123 and again sk-abc123 done", "sk-abc123")).toBe(
      "key=[REDACTED] and again [REDACTED] done",
    );
  });

  test("an empty secret is a no-op — never redacts against an empty string", () => {
    expect(redactSecret("hello world", "")).toBe("hello world");
  });

  test("text with no occurrence is returned unchanged", () => {
    expect(redactSecret("nothing sensitive here", "sk-abc123")).toBe("nothing sensitive here");
  });
});

describe("isDbLockedFailure / dbLockRetryDelayMs", () => {
  test("matches only a non-zero exit, zero events, database-is-locked stderr", () => {
    expect(isDbLockedFailure(1, 0, "Error: database is locked")).toBe(true);
    expect(isDbLockedFailure(1, 0, "SQLITE_BUSY: database is locked")).toBe(true);
  });

  test("does not match when events were produced — a real mid-run failure, not a lock race", () => {
    expect(isDbLockedFailure(1, 3, "database is locked")).toBe(false);
  });

  test("does not match a clean exit or unrelated stderr", () => {
    expect(isDbLockedFailure(0, 0, "database is locked")).toBe(false);
    expect(isDbLockedFailure(1, 0, "connection refused")).toBe(false);
  });

  test("retry delay is 1-4s jitter", () => {
    for (let i = 0; i < 20; i++) {
      const d = dbLockRetryDelayMs();
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThan(4000);
    }
  });
});

describe("computeOpencodeCostUsd", () => {
  test("input/output/reasoning/cache-read at the deepseek-v4.1-flash rates, reasoning billed as output", () => {
    const cost = computeOpencodeCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      reasoningTokens: 500_000,
      cacheReadTokens: 1_000_000,
    });
    // 1M input @ $0.15 + 1M (output+reasoning) @ $0.60 + 1M cache-read @ $0.003
    expect(cost).toBeCloseTo(0.15 + 0.6 + 0.003, 6);
  });

  test("zero tokens cost zero", () => {
    expect(
      computeOpencodeCostUsd({
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(0);
  });
});

describe("reduceOpencodeEvent over a real captured successful stream", () => {
  const fixtureLines = readFixture("opencode-events.jsonl");

  test("accumulates turns, tokens, lastAction, lastAssistantText, finished and the session id", () => {
    let accum = INITIAL_OPENCODE_ACCUM;
    for (const ev of fixtureLines) accum = reduceOpencodeEvent(accum, ev as never);

    expect(accum.sessionId).toBe("ses_f2b5129d1ffen3T90AH2DK2X8t");
    // Two step_finish events in the fixture, the last one reason: "stop".
    expect(accum.turns).toBe(2);
    expect(accum.finished).toBe(true);
    // Token sums across both step_finish events: input 12218+196, output 128+1690,
    // reasoning 32+1428, cache.read 20992+144128.
    expect(accum.inputTokens).toBe(12414);
    expect(accum.outputTokens).toBe(1818);
    expect(accum.reasoningTokens).toBe(1460);
    expect(accum.cacheReadTokens).toBe(165120);
    // Last tool_use is the errored webfetch call (no filePath/path/command in its input),
    // so describeOpencodeTool falls back to the bare tool name.
    expect(accum.lastAction).toBe("webfetch");
    expect(accum.lastAssistantText).toContain("HyperDX formula parser");
    // A per-tool "error" status (the webfetch call) is NOT the same as a top-level `error`
    // event — the session kept going, so this must stay false.
    expect(accum.sawErrorEvent).toBe(false);
  });

  test("finished reflects the LAST step_finish's reason, not an OR across every one", () => {
    // The fixture's first step_finish is reason "tool-calls" (mid-run), the second is "stop".
    let accum = INITIAL_OPENCODE_ACCUM;
    for (const ev of fixtureLines.slice(0, 3)) accum = reduceOpencodeEvent(accum, ev as never);
    expect(accum.finished).toBe(false); // only the "tool-calls" step_finish seen so far
  });

  test("sessionId is captured on the FIRST event that carries it, not overwritten later", () => {
    let accum = INITIAL_OPENCODE_ACCUM;
    accum = reduceOpencodeEvent(accum, fixtureLines[0] as never);
    expect(accum.sessionId).toBe("ses_f2b5129d1ffen3T90AH2DK2X8t");
    accum = reduceOpencodeEvent(accum, {
      ...(fixtureLines[1] as object),
      sessionID: "different-session",
    } as never);
    expect(accum.sessionId).toBe("ses_f2b5129d1ffen3T90AH2DK2X8t");
  });

  test("a bash tool_use describes as bash: <command>", () => {
    const accum = reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, {
      type: "tool_use",
      sessionID: "s",
      part: {
        type: "tool",
        tool: "bash",
        state: { status: "completed", input: { command: "git status" } },
      },
    } as never);
    expect(accum.lastAction).toBe("bash: git status");
  });

  test("an edit tool_use describes as <tool> <basename>", () => {
    const accum = reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, {
      type: "tool_use",
      sessionID: "s",
      part: {
        type: "tool",
        tool: "edit",
        state: { status: "completed", input: { filePath: "/repo/src/evaluators.py" } },
      },
    } as never);
    expect(accum.lastAction).toBe("edit evaluators.py");
  });
});

describe("reduceOpencodeEvent over real captured FAILING streams (B1)", () => {
  test("a rejected apiKey's error event: nested error.data.message, sawErrorEvent true, never finished", () => {
    const [ev] = readFixture("opencode-events-error.jsonl");
    let accum = reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, ev as never);
    expect(accum.sawErrorEvent).toBe(true);
    expect(accum.errorMessage).toBe("Unauthorized: Unauthorized: Authorization parsing failed");
    expect(accum.finished).toBe(false);
  });

  test("an unrecognized model id's error event: falls back to error.name when data.message differs", () => {
    const [, ev] = readFixture("opencode-events-error.jsonl");
    const accum = reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, ev as never);
    expect(accum.sawErrorEvent).toBe(true);
    expect(accum.errorMessage).toBe("Unexpected server error. Check server logs for details.");
  });

  test("error.name is the fallback when error.data.message is absent", () => {
    const accum = reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, {
      type: "error",
      sessionID: "s",
      error: { name: "SomeBareError" },
    } as never);
    expect(accum.errorMessage).toBe("SomeBareError");
  });

  test("a bare/legacy string error field (no longer produced, but tolerated) does not crash the reducer", () => {
    expect(() =>
      reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, {
        type: "error",
        sessionID: "s",
        error: undefined,
      } as never),
    ).not.toThrow();
  });
});

describe("runOpencodeAttempt — model/variant guards (I3, before any spawn or IU config call)", () => {
  test("refuses any model other than deepseek-v4.1-flash", async () => {
    await expect(
      runOpencodeAttempt(
        { cwd: "/tmp", prompt: "p", route: routeFor("dispatch") },
        { current: 0 },
        { model: "DeepSeek-V4-Pro", backend: "iu" },
      ),
    ).rejects.toThrow(/only supports deepseek-v4\.1-flash/);
  });

  test("refuses an undeclared variant", async () => {
    await expect(
      runOpencodeAttempt(
        { cwd: "/tmp", prompt: "p", route: routeFor("dispatch") },
        { current: 0 },
        { model: "deepseek-v4.1-flash", backend: "iu", variant: "ultra-mega" },
      ),
    ).rejects.toThrow(/unknown opencode variant "ultra-mega"/);
  });

  test("refuses extraDisallowedTools — no caller passes this for a dispatch route", async () => {
    await expect(
      runOpencodeAttempt(
        { cwd: "/tmp", prompt: "p", extraDisallowedTools: ["Bash"], route: routeFor("dispatch") },
        { current: 0 },
        { model: "deepseek-v4.1-flash", backend: "iu" },
      ),
    ).rejects.toThrow(/extraDisallowedTools is not supported/);
  });
});
