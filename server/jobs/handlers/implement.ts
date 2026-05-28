import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { runSession, zodValidator } from "../../mcp/session-runner.ts";
import { logger } from "../../mcp/logger.ts";
import type { ProgressSink } from "../store.ts";
import { parseParams } from "./util.ts";
import { readTavilyKey } from "./research.ts";

/** Repo-relative paths of working-tree changes (modified, added, untracked, renamed dest). */
function gitChangedFiles(cwd: string): string[] {
  try {
    const r = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=all"], { cwd });
    if (r.exitCode !== 0) return [];
    return r.stdout
      .toString()
      .split("\n")
      .map((l) => l.replace(/^.. /, "").trim()) // strip the 2-char XY status + space
      .filter(Boolean)
      .map((p) => (p.includes(" -> ") ? (p.split(" -> ")[1] ?? p) : p)); // rename → dest
  } catch {
    return [];
  }
}

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
  validateCmd: z
    .string()
    .optional()
    .describe(
      "Optional exact command(s) the worker runs to self-verify its change, e.g. " +
        "'.venv/bin/pyrefly check && .venv/bin/pytest -q tests/foo'. When provided, the " +
        "worker runs THIS verbatim instead of discovering the repo's runner — this is the " +
        "single biggest waste-preventer on non-Node repos (workers otherwise burn their " +
        "whole turn budget, and may hit the hard timeout, hunting for a test runner). " +
        "Omit on Node/Bun repos where `bun run typecheck/lint/test` is reliably auto-detected.",
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

async function loadSkillPrompt(
  task: string,
  context: string | undefined,
  validateCmd: string | undefined,
): Promise<string> {
  const skillPath = join(import.meta.dir, "../../skills/implement.md");
  if (!existsSync(skillPath)) {
    throw new Error(`implement skill prompt not found at ${skillPath}`);
  }
  const template = await Bun.file(skillPath).text();
  const contextBlock = context ? `\n## Context\n\n${context}\n` : "";
  const validateBlock = validateCmd
    ? `\n## Validation command (run THIS to self-verify — do not hunt for a runner)\n\n` +
      `After your edits are on disk, self-verify by running EXACTLY this via Bash, then ` +
      `report its outcome in \`checkPassed\`:\n\n\`\`\`\n${validateCmd}\n\`\`\`\n\n` +
      `Do NOT spend turns discovering an alternative runner — this is the authoritative ` +
      `command. Fix only failures YOUR change introduced; report pre-existing ones in \`notes\`.\n`
    : "";
  return template
    .replace("{{TASK}}", task)
    .replace("{{CONTEXT}}", contextBlock)
    .replace("{{VALIDATE}}", validateBlock);
}

// ── Core ───────────────────────────────────────────────────────────────────────

/** Delegate a scoped coding task to a worker that edits files, self-verifies, and
 *  reports. Throws on failure. The worker gets the Tavily key in its env so it can
 *  verify a library/API inline (the research capability) without a nested job. */
export async function runImplement(
  rawParams: Record<string, unknown>,
  onProgress?: ProgressSink,
): Promise<ImplementOutput> {
  const { cwd, task, context, validateCmd } = parseParams(IMPLEMENT_INPUT, rawParams);
  if (!existsSync(cwd)) throw new Error(`Directory not found: ${cwd}`);

  const prompt = await loadSkillPrompt(task, context, validateCmd);
  const tavilyKey = await readTavilyKey();

  // Snapshot the working tree so a no-output recovery can report only the files
  // THIS run touched, not pre-existing dirt.
  const before = new Set(gitChangedFiles(cwd));

  const result = await runSession<ImplementOutput>({
    cwd,
    prompt,
    tool: "implement",
    model: "Kimi-K2.6",
    jsonSchema: IMPLEMENT_JSON_SCHEMA,
    maxTurns: 100,
    timeoutMs: 20 * 60 * 1000,
    // Full file access (no readOnly) — implement must edit. Load global rules so
    // the worker follows the user's code-style/typescript conventions.
    settingSources: "user,project",
    extraEnv: tavilyKey ? { TAVILY_API_KEY: tavilyKey } : undefined,
    validate: zodValidator(IMPLEMENT_OUTPUT),
    onActivity: onProgress,
  });

  if (result.ok && result.data) return result.data;

  // The session emitted no parseable report (the Kimi/bridge "empty result" failure
  // mode) — but it may have completed the edits regardless. Reconcile against git:
  // disk is the ground truth, so a job that wrote files reports `applied: true`
  // honestly instead of a misleading hard failure. Only for `noOutput` — a timeout
  // or non-zero exit is a real failure worth surfacing as-is.
  if (result.noOutput) {
    const after = gitChangedFiles(cwd);
    const newlyChanged = after.filter((f) => !before.has(f));
    logger.warn(
      { event: "implement.git_recovery", project: cwd, newlyChanged: newlyChanged.length },
      "implement produced no report; reconciled against working tree",
    );
    return {
      applied: newlyChanged.length > 0,
      summary:
        newlyChanged.length > 0
          ? `Worker emitted no structured report, but the working tree shows ${newlyChanged.length} changed file(s). Result reconstructed from git — the change description is unavailable.`
          : "Worker emitted no structured report and the working tree shows no new changes from this run.",
      filesChanged: newlyChanged,
      checkPassed: null,
      notes:
        "UNVERIFIED REPORT: the worker did not return its JSON envelope (known Kimi/bridge empty-result failure); " +
        "this result was reconstructed from `git status`. Inspect the diff and run the repo's checks yourself before " +
        "trusting it — `applied`/`filesChanged` reflect the working tree, not the worker's own account.",
    };
  }

  throw new Error(result.error ?? "implement produced no result");
}
