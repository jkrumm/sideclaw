import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { runSession, zodValidator } from "../../mcp/session-runner.ts";
import type { ProgressSink } from "../store.ts";
import { parseParams } from "./util.ts";

// ── Input schema (single source for MCP inputSchema + execution validation) ───

export const CHECK_INPUT = z.object({
  cwd: z
    .string()
    .describe(
      "Absolute path to the git repo root to validate. Must be an existing git repository. Supports git worktrees.",
    ),
  commands: z
    .array(z.string())
    .optional()
    .describe(
      "Optional explicit validation commands to run verbatim, in order, e.g. " +
        "['.venv/bin/ruff check', '.venv/bin/pyrefly check', '.venv/bin/pytest -q']. " +
        "When provided, the worker runs ONLY these and skips ecosystem auto-discovery — " +
        "this avoids burning wall-clock hunting for the test runner (the #1 time-sink on " +
        "non-Node repos). Each command becomes one step named after its first token. " +
        "Omit on Node/Bun repos where package.json scripts are auto-detected reliably.",
    ),
});

export type CheckParams = z.infer<typeof CHECK_INPUT>;

// ── Output schema — single source of truth ────────────────────────────────────

export const CHECK_OUTPUT = z.object({
  passed: z.boolean().describe("True only if every step passed."),
  steps: z
    .array(
      z.object({
        name: z.string().describe("Step name: format | lint | typecheck | test | fallow"),
        passed: z.boolean(),
        errors: z
          .array(z.string())
          .optional()
          .describe("Error lines. Only present when passed is false."),
      }),
    )
    .describe("Only steps that were actually run (skipped if script absent)."),
  summary: z
    .string()
    .describe("One-line result, e.g. 'All 3 steps passed' or '1/3 failed: lint (5 errors)'."),
});

const CHECK_JSON_SCHEMA = z.toJSONSchema(CHECK_OUTPUT);

export type CheckOutput = z.infer<typeof CHECK_OUTPUT>;

// ── Skill prompt loader ────────────────────────────────────────────────────────

async function loadSkillPrompt(commands: string[] | undefined): Promise<string> {
  const skillPath = join(import.meta.dir, "../../skills/check.md");
  if (!existsSync(skillPath)) {
    throw new Error(`check skill prompt not found at ${skillPath}`);
  }
  const template = await Bun.file(skillPath).text();
  const block =
    commands && commands.length > 0
      ? "## Explicit commands (run THESE, skip discovery)\n\n" +
        "The caller supplied the exact validation commands. Run ONLY these, in order, " +
        "via Bash — do NOT auto-detect the ecosystem or read package.json/pyproject.toml. " +
        "Name each step after the command's first token (or the tool it invokes):\n\n" +
        commands.map((c) => `- \`${c}\``).join("\n") +
        "\n"
      : "";
  return template.replace("{{COMMANDS}}", block);
}

// ── Core ───────────────────────────────────────────────────────────────────────

/** Run all available validation steps and return structured pass/fail. Throws on failure. */
export async function runCheck(
  rawParams: Record<string, unknown>,
  onProgress?: ProgressSink,
): Promise<CheckOutput> {
  const { cwd, commands } = parseParams(CHECK_INPUT, rawParams);
  if (!existsSync(cwd)) throw new Error(`Directory not found: ${cwd}`);

  const prompt = await loadSkillPrompt(commands);
  const result = await runSession<CheckOutput>({
    cwd,
    prompt,
    jsonSchema: CHECK_JSON_SCHEMA,
    maxTurns: 30,
    timeoutMs: 10 * 60 * 1000,
    readOnly: true,
    validate: zodValidator(CHECK_OUTPUT),
    onActivity: onProgress,
  });

  if (!result.ok || !result.data) {
    throw new Error(result.error ?? "check produced no result");
  }
  return result.data;
}
