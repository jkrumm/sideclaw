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

async function loadSkillPrompt(): Promise<string> {
  const skillPath = join(import.meta.dir, "../../skills/check.md");
  if (!existsSync(skillPath)) {
    throw new Error(`check skill prompt not found at ${skillPath}`);
  }
  return Bun.file(skillPath).text();
}

// ── Core ───────────────────────────────────────────────────────────────────────

/** Run all available validation steps and return structured pass/fail. Throws on failure. */
export async function runCheck(
  rawParams: Record<string, unknown>,
  onProgress?: ProgressSink,
): Promise<CheckOutput> {
  const { cwd } = parseParams(CHECK_INPUT, rawParams);
  if (!existsSync(cwd)) throw new Error(`Directory not found: ${cwd}`);

  const prompt = await loadSkillPrompt();
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
