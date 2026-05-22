import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { runSession, zodValidator } from "../../mcp/session-runner.ts";
import { parseParams } from "./util.ts";
import { readTavilyKey } from "./research.ts";

// ── Input schema ─────────────────────────────────────────────────────────────

export const IMPLEMENT_INPUT = z.object({
  cwd: z
    .string()
    .describe(
      "Absolute path to the git repo root to work in. Must be an existing git repository. Supports git worktrees.",
    ),
  task: z
    .string()
    .min(10)
    .describe(
      "Precise, self-contained implementation instruction: what to build or change, acceptance criteria, and any constraints. The worker executes it literally — be specific.",
    ),
  context: z
    .string()
    .optional()
    .describe(
      "Optional supporting context: relevant file paths, the plan, API shapes, or conventions to follow. Reduces exploration time.",
    ),
});

export type ImplementParams = z.infer<typeof IMPLEMENT_INPUT>;

// ── Output schema — single source of truth ────────────────────────────────────

export const IMPLEMENT_OUTPUT = z.object({
  applied: z.boolean().describe("True only if files were actually created or modified."),
  summary: z.string().describe("What changed and why, 2-4 sentences."),
  filesChanged: z
    .array(z.string())
    .describe("Repo-relative paths created or modified. Empty if applied is false."),
  checkPassed: z
    .boolean()
    .nullable()
    .describe("Result of running the repo's validation, or null if no checks exist."),
  notes: z
    .string()
    .describe(
      "Caveats the orchestrator must know: assumptions, pre-existing failures left untouched, follow-ups, or why applied is false.",
    ),
});

const IMPLEMENT_JSON_SCHEMA = z.toJSONSchema(IMPLEMENT_OUTPUT);

export type ImplementOutput = z.infer<typeof IMPLEMENT_OUTPUT>;

// ── Skill prompt loader ────────────────────────────────────────────────────────

async function loadSkillPrompt(task: string, context: string | undefined): Promise<string> {
  const skillPath = join(import.meta.dir, "../../skills/implement.md");
  if (!existsSync(skillPath)) {
    throw new Error(`implement skill prompt not found at ${skillPath}`);
  }
  const template = await Bun.file(skillPath).text();
  const contextBlock = context ? `\n## Context\n\n${context}\n` : "";
  return template.replace("{{TASK}}", task).replace("{{CONTEXT}}", contextBlock);
}

// ── Core ───────────────────────────────────────────────────────────────────────

/** Delegate a scoped coding task to a worker that edits files, self-verifies, and
 *  reports. Throws on failure. The worker gets the Tavily key in its env so it can
 *  verify a library/API inline (the research capability) without a nested job. */
export async function runImplement(rawParams: Record<string, unknown>): Promise<ImplementOutput> {
  const { cwd, task, context } = parseParams(IMPLEMENT_INPUT, rawParams);
  if (!existsSync(cwd)) throw new Error(`Directory not found: ${cwd}`);

  const prompt = await loadSkillPrompt(task, context);
  const tavilyKey = await readTavilyKey();

  const result = await runSession<ImplementOutput>({
    cwd,
    prompt,
    model: "Kimi-K2.6",
    jsonSchema: IMPLEMENT_JSON_SCHEMA,
    maxTurns: 100,
    timeoutMs: 20 * 60 * 1000,
    // Full file access (no readOnly) — implement must edit. Load global rules so
    // the worker follows the user's code-style/typescript conventions.
    settingSources: "user,project",
    extraEnv: tavilyKey ? { TAVILY_API_KEY: tavilyKey } : undefined,
    validate: zodValidator(IMPLEMENT_OUTPUT),
  });

  if (!result.ok || !result.data) {
    throw new Error(result.error ?? "implement produced no result");
  }
  return result.data;
}
