import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { runSession, zodValidator } from "../../mcp/session-runner.ts";
import { routeFor } from "../../lib/routing.ts";
import { appLogger as logger } from "../../logger.ts";
import type { ProgressSink } from "../store.ts";
import { parseParams } from "./util.ts";
import { JSON_ONLY_RETRY, loadSkillFile, unwrap } from "../../lib/worker-io.ts";

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
  stepTimeoutSeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Override the per-step idle-timeout window: seconds of no NEW output before a step " +
        "is judged stuck and killed. It is an idle watchdog, not a wall clock — a step that " +
        "keeps producing output past this many seconds is never killed on elapsed time " +
        "alone. Applies to every step, including test. Default when omitted: 180s for " +
        "ordinary steps, 600s for the test step specifically (e2e suites legitimately go " +
        "quiet for minutes between assertions). Raise this per call for a repo whose suite " +
        "needs more headroom than the default.",
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

// ── Command safety — idle watchdog ──────────────────────────────────────────────
//
// A hung command must never stall the job, but a fixed wall-clock cap (the old `timeout
// 180 <cmd>`) kills legitimate long-running steps too — an e2e suite that runs minutes but
// keeps producing output is indistinguishable, on elapsed time alone, from one that is
// actually wedged (rollhook had to rename its e2e `test` script to dodge exactly this — see
// rollhook#26). The owner's standing rule is "no wall-clock ceilings on agent work, only
// idle watchdogs" — so this caps IDLE time (no new output) instead of total time.

/** Ordinary-step idle window when the caller does not override it. */
const DEFAULT_STEP_IDLE_SECONDS = 180;
/** The test step specifically defaults higher — e2e suites legitimately go quiet between
 *  assertions for longer than a lint or typecheck step ever should. */
const DEFAULT_TEST_IDLE_SECONDS = 600;

/** The idle-watchdog instructions, parameterized by the effective idle windows. Shared by
 *  both prompt paths (explicit-commands and discovery) so they can never drift — the
 *  watchdog shell function itself is worker-authored bash embedded in the prompt (there is
 *  no handler-side subprocess to attach a real idle timer to; the worker's own Bash tool is
 *  the only thing actually running the command), so keeping one copy of the recipe matters. */
function idleWatchdogBlock(stepSeconds: number, testSeconds: number): string {
  return (
    `## Command safety — idle watchdog, not a wall clock\n\n` +
    `A hung command must never stall the job. But many legitimate steps (e2e suites, slow ` +
    `integration tests) run for minutes while still producing output — do NOT cap on ` +
    `elapsed time. Cap on IDLE time instead: kill a step only once it has produced no NEW ` +
    `output for its idle window.\n\n` +
    `Before running any command, define this helper once in your Bash session:\n\n` +
    "    run_step() {\n" +
    '      local cmd="$1" idle="$2" out; out=$(mktemp)\n' +
    '      eval "$cmd" >"$out" 2>&1 &\n' +
    "      local pid=$! last=0 stalled=0\n" +
    '      while kill -0 "$pid" 2>/dev/null; do\n' +
    "        sleep 5\n" +
    '        local size; size=$(wc -c <"$out")\n' +
    '        if [ "$size" != "$last" ]; then last=$size; stalled=0; else stalled=$((stalled + 5)); fi\n' +
    '        if [ "$stalled" -ge "$idle" ]; then\n' +
    '          kill -9 "$pid" 2>/dev/null\n' +
    '          echo "IDLE_TIMEOUT: no output for ${idle}s" >>"$out"\n' +
    "          break\n" +
    "        fi\n" +
    "      done\n" +
    '      wait "$pid" 2>/dev/null; local code=$?\n' +
    '      cat "$out"; rm -f "$out"\n' +
    "      return $code\n" +
    "    }\n\n" +
    `Run every command through it: \`run_step '<cmd>' <idle-seconds>\` — use ${stepSeconds} ` +
    `for ordinary steps and ${testSeconds} for the test step specifically (both are ` +
    `caller-configured; use these exact numbers, do not substitute your own). If \`run_step\` ` +
    `cannot be defined (no bash, restricted shell), fall back to \`timeout ${stepSeconds} ` +
    `<cmd>\` (or \`gtimeout\`) as a wall-clock approximation. "IDLE_TIMEOUT" appearing in the ` +
    `captured output (or exit code 124 from the timeout fallback) means the watchdog killed ` +
    `it — mark that step failed with "no output for <idle-seconds>s — likely a watch-mode ` +
    `runner or a hung process" and move on, never retry. If a test command reports no tests ` +
    `("0 test files", "No test files found", pytest exit 5), mark the step passed — an ` +
    `empty suite is not a failure.`
  );
}

/** Minimal, self-contained prompt for the explicit-commands fast path. Loads NO
 *  discovery skill — the worker runs exactly the given commands and nothing else
 *  (no ecosystem sniffing, no fallow, no `git remote -v`/`which`). This is what
 *  keeps the fast path fast: discovery is the dominant turn-sink otherwise. */
function explicitCommandsPrompt(
  commands: string[],
  stepSeconds: number,
  testSeconds: number,
): string {
  return (
    `You are a code quality checker. The caller supplied the EXACT validation commands. ` +
    `Run ONLY these, in order, via Bash — capture stdout+stderr for each. A step passes if ` +
    `its exit code is 0, fails otherwise (collect the error lines into \`errors\`). Name each ` +
    `step after the command's tool (e.g. "ruff", "pytest", "pyrefly", "lint", "test").\n\n` +
    `Run EXACTLY these and nothing else. Do NOT explore the repo, read package.json/` +
    `pyproject.toml, sniff the ecosystem, run \`which\`/\`git remote -v\`, or run \`fallow\`. ` +
    `As soon as every command has run once, emit the JSON — do not re-run or re-read.\n\n` +
    `${idleWatchdogBlock(stepSeconds, testSeconds)}\n\n` +
    commands.map((c, i) => `${i + 1}. \`${c}\``).join("\n") +
    `\n\n` +
    OUTPUT_CONTRACT
  );
}

async function loadSkillPrompt(
  commands: string[] | undefined,
  stepSeconds: number,
  testSeconds: number,
): Promise<string> {
  if (commands && commands.length > 0)
    return explicitCommandsPrompt(commands, stepSeconds, testSeconds);
  const skillPath = join(import.meta.dir, "../../skills/check.md");
  // Discovery path: drop the (now-unused) explicit-commands placeholder, and splice in the
  // caller-configured idle-watchdog block so both prompt paths run the same recipe.
  const template = await loadSkillFile(skillPath, "check");
  return template
    .replace("{{COMMANDS}}\n", "")
    .replace("{{COMMANDS}}", "")
    .replace("{{TIMEOUT_BLOCK}}", idleWatchdogBlock(stepSeconds, testSeconds));
}

// ── Core ───────────────────────────────────────────────────────────────────────

/** Run all available validation steps and return structured pass/fail. Throws on failure. */
export async function runCheck(
  rawParams: Record<string, unknown>,
  onProgress?: ProgressSink,
  jobId?: string,
  isCancelled?: (jobId: string) => boolean,
): Promise<CheckOutput> {
  const { cwd, commands, stepTimeoutSeconds } = parseParams(CHECK_INPUT, rawParams);
  if (!existsSync(cwd)) throw new Error(`Directory not found: ${cwd}`);

  // A caller-supplied override applies uniformly to every step, including test — it is an
  // explicit "this repo's suite needs more (or less) headroom than the default" statement,
  // not a per-step distinction the caller is expected to make.
  const stepSeconds = stepTimeoutSeconds ?? DEFAULT_STEP_IDLE_SECONDS;
  const testSeconds = stepTimeoutSeconds ?? DEFAULT_TEST_IDLE_SECONDS;
  const prompt = await loadSkillPrompt(commands, stepSeconds, testSeconds);
  const runWorker = (p: string) =>
    runSession<CheckOutput>({
      cwd,
      prompt: p,
      tool: "check",
      jobId,
      isCancelled,
      jsonSchema: CHECK_JSON_SCHEMA,
      route: routeFor("check"),
      readOnly: true,
      // No `retryAfterOutput`: glm-5.3-flash thinking is capped at 2048 tokens here
      // (`ToolRoute.thinkingTokens`, MAX_THINKING_TOKENS), but it can still run genuinely
      // slow on hard validation runs, not stuck — a timeout after it has already produced
      // turns used to re-lane onto Haiku mid-job instead of just letting it finish. The
      // idle watchdog in session-runner.ts is the real stuck-detector now; only a
      // zero-output timeout still moves lanes.
      validate: zodValidator(CHECK_OUTPUT),
      onActivity: onProgress,
    });

  let result = await runWorker(prompt);
  // Only the prose-instead-of-JSON case is retried (`noOutput`): a timeout, non-zero exit
  // or transport failure has already been through the runner's own retry policy and a
  // second full validator run would just double the cost of a real outage.
  if (!result.ok && result.noOutput) {
    logger.warn(
      { event: "check.retry", tool: "check", project: cwd, error: result.error },
      "check output was not schema JSON — retrying once with JSON-only directive",
    );
    result = await runWorker(prompt + JSON_ONLY_RETRY);
  }

  return unwrap(result, "check");
}
