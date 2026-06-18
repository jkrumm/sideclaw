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

// JSON output contract — shared by both prompt paths so they never drift.
const OUTPUT_CONTRACT = `## Output

Return ONLY a JSON object with this exact structure (no explanation, no markdown, just JSON):

{
"passed": <boolean>,
"steps": [
{ "name": "<step-name>", "passed": <boolean>, "errors": ["<error line>", ...] }
],
"summary": "<one-line summary, e.g. 'All 3 steps passed' or '1/3 steps failed: lint (5 errors)'>"
}

Only include \`errors\` when the step failed. \`passed\` at root is true only if ALL steps that ran passed.`;

/** Minimal, self-contained prompt for the explicit-commands fast path. Loads NO
 *  discovery skill — the worker runs exactly the given commands and nothing else
 *  (no ecosystem sniffing, no fallow, no `git remote -v`/`which`). This is what
 *  keeps the fast path fast: discovery is the dominant turn-sink otherwise. */
function explicitCommandsPrompt(commands: string[]): string {
  return (
    `You are a code quality checker. The caller supplied the EXACT validation commands. ` +
    `Run ONLY these, in order, via Bash — capture stdout+stderr for each. A step passes if ` +
    `its exit code is 0, fails otherwise (collect the error lines into \`errors\`). Name each ` +
    `step after the command's tool (e.g. "ruff", "pytest", "pyrefly", "lint", "test").\n\n` +
    `Run EXACTLY these and nothing else. Do NOT explore the repo, read package.json/` +
    `pyproject.toml, sniff the ecosystem, run \`which\`/\`git remote -v\`, or run \`fallow\`. ` +
    `As soon as every command has run once, emit the JSON — do not re-run or re-read.\n\n` +
    `Wrap each command in a wall-clock cap so a hung or watch-mode process can't stall the ` +
    `job: prefer \`timeout 180 <cmd>\` (or \`gtimeout 180\`); if neither exists, set your Bash ` +
    `tool's own timeout to 180000 ms. Exit code 124 means the cap killed it — mark that step ` +
    `failed with "timed out after 180s" and move on, never retry. If a test command reports no ` +
    `tests ("0 test files", "No test files found", pytest exit 5), mark the step passed — an ` +
    `empty suite is not a failure.\n\n` +
    commands.map((c, i) => `${i + 1}. \`${c}\``).join("\n") +
    `\n\n` +
    OUTPUT_CONTRACT
  );
}

async function loadSkillPrompt(commands: string[] | undefined): Promise<string> {
  if (commands && commands.length > 0) return explicitCommandsPrompt(commands);
  const skillPath = join(import.meta.dir, "../../skills/check.md");
  if (!existsSync(skillPath)) {
    throw new Error(`check skill prompt not found at ${skillPath}`);
  }
  // Discovery path: drop the (now-unused) explicit-commands placeholder.
  const template = await Bun.file(skillPath).text();
  return template.replace("{{COMMANDS}}\n", "").replace("{{COMMANDS}}", "");
}

// ── Core ───────────────────────────────────────────────────────────────────────

/** Run all available validation steps and return structured pass/fail. Throws on failure. */
export async function runCheck(
  rawParams: Record<string, unknown>,
  onProgress?: ProgressSink,
): Promise<CheckOutput> {
  const { cwd, commands } = parseParams(CHECK_INPUT, rawParams);
  if (!existsSync(cwd)) throw new Error(`Directory not found: ${cwd}`);

  const cmdCount = commands?.length ?? 0;
  const prompt = await loadSkillPrompt(commands);
  const result = await runSession<CheckOutput>({
    cwd,
    prompt,
    tool: "check",
    jsonSchema: CHECK_JSON_SCHEMA,
    // Fast path needs only one Bash turn per command + the JSON turn — cap tight so
    // a churny worker can't burn the discovery-sized budget it no longer needs.
    maxTurns: cmdCount > 0 ? cmdCount + 6 : 30,
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
