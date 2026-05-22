import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { runSession, zodValidator } from "../../mcp/session-runner.ts";
import { appLogger as logger } from "../../logger.ts";
import { parseParams } from "./util.ts";

// Max angle sessions in flight at once. Kimi-K2.6 is single-backend (Azure
// Sweden) and 429s under burst load; capping keeps the LiteLLM Kimi→sonnet-eu
// fallback from stampeding when 4–6 angles fire together.
const ANGLE_CONCURRENCY = 3;

// Hard cap on total angles per review. Floor angles (architect, senior-dev, +
// file-type matches) are kept first; the router's extra angles fill remaining
// slots. Bounds cost and wall time (more angles = more concurrency waves).
const MAX_ANGLES = 8;

/** Run `fn` over `items` with at most `limit` in flight. Preserves input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Input schema ─────────────────────────────────────────────────────────────

export const REVIEW_INPUT = z.object({
  cwd: z
    .string()
    .describe("Absolute path to the git repo root to review. Must be an existing git repository."),
  scope: z
    .string()
    .optional()
    .describe(
      'What to review. "uncommitted" (default) = staged + unstaged changes. "head" = last commit. A commit ref like "HEAD~3" or a SHA = the range from that ref up to HEAD (i.e. the last N commits, not the single commit). An explicit range like "main..HEAD" or a file path also work.',
    ),
  context: z
    .string()
    .optional()
    .describe(
      'Factual description of the changes\' intent (e.g. "add MCP review tool"). Helps catch goal-mismatch bugs. Omit if the diff is self-explanatory.',
    ),
  angles: z
    .array(z.string())
    .optional()
    .describe(
      "Explicit reviewer angles to run, overriding the router. Valid: architect, senior-dev, frontend, backend, typescript, qa, security, performance, concurrency, data-migration, api-contract. Baseline architect + senior-dev are always included. Omit to let the router pick based on the diff.",
    ),
});

export type ReviewParams = z.infer<typeof REVIEW_INPUT>;

// ── Output schema — single source of truth ────────────────────────────────────

const FINDING = z.object({
  file: z.string().describe("Relative file path from repo root."),
  line: z.number().optional().describe("Line number, if identifiable."),
  message: z.string().describe("What the issue is, why it matters, and how to fix it."),
  angle: z
    .string()
    .describe(
      "Which reviewer caught this: architect | senior-dev | frontend | backend | typescript | qa | security | performance | concurrency | data-migration | api-contract | coderabbit | fallow",
    ),
});

export const REVIEW_OUTPUT = z.object({
  outcome: z
    .enum(["clean", "actionable", "needs-human"])
    .describe(
      'Review verdict. "clean" = no findings. "actionable" = items for implementation agent. "needs-human" = has discussions requiring human decision.',
    ),
  blocking: z
    .array(FINDING)
    .describe("Bugs, security issues, type errors, data loss — must fix before merging."),
  improvements: z
    .array(FINDING)
    .describe(
      "Code quality, readability, small refactors — recommended fixes the implementation agent should apply.",
    ),
  discussions: z
    .array(FINDING)
    .describe("Big refactors, architecture changes, technology choices — needs human decision."),
  testGaps: z
    .array(z.string())
    .describe("Missing test coverage, e.g. 'server/auth.ts — unit: expired token, revoked token'."),
  summary: z
    .string()
    .describe(
      "2-3 sentence assessment with outcome, key findings, and code health. E.g. 'Actionable: 1 blocking null-check, 3 improvements. Clean architecture, good separation.'",
    ),
});

const REVIEW_JSON_SCHEMA = z.toJSONSchema(REVIEW_OUTPUT);

export type ReviewOutput = z.infer<typeof REVIEW_OUTPUT>;

// ── Angle session output — simpler schema for individual reviewers ─────────────

const ANGLE_FINDING = z.object({
  severity: z.enum(["blocking", "improvement", "discussion"]),
  file: z.string(),
  line: z.number().optional(),
  message: z.string(),
});

const ANGLE_OUTPUT = z.object({
  findings: z.array(ANGLE_FINDING),
});

const ANGLE_JSON_SCHEMA = z.toJSONSchema(ANGLE_OUTPUT);

type AngleOutput = z.infer<typeof ANGLE_OUTPUT>;

// ── Skill prompt loader ────────────────────────────────────────────────────────

const SKILL_DIR = join(import.meta.dir, "../../skills/review");

async function loadAnglePrompt(angle: string): Promise<string> {
  const path = join(SKILL_DIR, `${angle}.md`);
  if (!existsSync(path)) {
    throw new Error(`review angle prompt not found: ${path}`);
  }
  return Bun.file(path).text();
}

// ── Scope validation ───────────────────────────────────────────────────────────

/** Allowlist: alphanumerics, hyphens, underscores, slashes, dots, tildes, carets. */
const SAFE_SCOPE = /^[a-zA-Z0-9._/~^@{}-]+$/;

function validateScope(scope: string): void {
  if (scope === "uncommitted" || scope === "head") return;
  if (!SAFE_SCOPE.test(scope)) {
    throw new Error(`Invalid scope — contains unsafe characters: ${scope}`);
  }
}

// ── Git diff helpers ───────────────────────────────────────────────────────────

// A bare commit-ish ref (e.g. "HEAD~2", a SHA, a branch) is treated as the
// range `<ref>..HEAD` — "everything from that ref up to HEAD" — which is what a
// caller passing "HEAD~3" almost always means. `git show <ref>` (the single
// commit) was a footgun: it silently reviewed one old commit instead of the
// recent work. Explicit ranges ("main..HEAD") and paths pass through unchanged.
function scopeDiffArgs(scope: string): string {
  if (scope.includes("..")) return scope; // explicit range
  if (scope.startsWith("/") || scope.includes(".")) return `-- ${scope}`; // file path
  return `${scope} HEAD`; // bare ref → range up to HEAD
}

function gitDiffCommand(scope: string): string {
  switch (scope) {
    case "uncommitted":
      return 'diff=$(git diff --cached); [ -z "$diff" ] && diff=$(git diff); echo "$diff"';
    case "head":
      return "git show HEAD";
    default:
      return `git diff ${scopeDiffArgs(scope)}`;
  }
}

function gitDiffFilesCommand(scope: string): string {
  switch (scope) {
    case "uncommitted":
      return 'files=$(git diff --cached --name-only); [ -z "$files" ] && files=$(git diff --name-only); echo "$files"';
    case "head":
      return "git show HEAD --name-only --format=''";
    default:
      return `git diff --name-only ${scopeDiffArgs(scope)}`;
  }
}

// ── Shell helpers ──────────────────────────────────────────────────────────────

async function shell(
  cmd: string,
  cwd: string,
  timeoutMs = 30_000,
): Promise<{ stdout: string; ok: boolean }> {
  try {
    const proc = Bun.spawn(["bash", "-c", cmd], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Two-stage timeout: SIGTERM → 5s grace → SIGKILL
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      sigkillTimer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
        sigkillTimer = null;
      }, 5000);
    }, timeoutMs);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timeout);
    if (sigkillTimer) clearTimeout(sigkillTimer);

    // Merge stderr into stdout — tools like fallow/coderabbit may write findings to stderr
    const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    return { stdout: combined, ok: exitCode === 0 };
  } catch {
    return { stdout: "", ok: false };
  }
}

// ── Agent selection ────────────────────────────────────────────────────────────

interface AgentConfig {
  angle: string;
  label: string;
}

interface AngleResult {
  angle: string;
  findings: AngleOutput["findings"];
  failureReason?: string;
}

function selectAgents(changedFiles: string[], hasTestScript: boolean): AgentConfig[] {
  const agents: AgentConfig[] = [
    { angle: "architect", label: "Architect" },
    { angle: "senior-dev", label: "Senior Dev" },
  ];

  const hasFrontend = changedFiles.some((f) => /\.(tsx|jsx|css)$/i.test(f));
  const hasBackend = changedFiles.some(
    (f) => /\.(ts)$/i.test(f) && /(^|\/)(?:api|server)\//.test(f),
  );
  const hasTypeScript = changedFiles.some((f) => /\.(ts|tsx)$/i.test(f));

  if (hasFrontend) agents.push({ angle: "frontend", label: "Frontend Expert" });
  if (hasBackend) agents.push({ angle: "backend", label: "Backend Expert" });
  if (hasTypeScript) agents.push({ angle: "typescript", label: "TypeScript Expert" });
  if (hasTestScript) agents.push({ angle: "qa", label: "QA Engineer" });

  return agents;
}

// ── Dynamic angle routing ────────────────────────────────────────────────────────

// Router-only angles: content-driven reviewers that file extensions can't detect.
const ROUTER_ANGLE_LABELS: Record<string, string> = {
  security: "Security Reviewer",
  performance: "Performance Reviewer",
  concurrency: "Concurrency Reviewer",
  "data-migration": "Data & Migration Reviewer",
  "api-contract": "API Contract Reviewer",
};

// Every angle the caller may request explicitly via the `angles` input.
const ALL_ANGLE_LABELS: Record<string, string> = {
  architect: "Architect",
  "senior-dev": "Senior Dev",
  frontend: "Frontend Expert",
  backend: "Backend Expert",
  typescript: "TypeScript Expert",
  qa: "QA Engineer",
  ...ROUTER_ANGLE_LABELS,
};

const ROUTER_OUTPUT = z.object({
  angles: z.array(z.string()),
  rationale: z.string().optional(),
});

const ROUTER_JSON_SCHEMA = z.toJSONSchema(ROUTER_OUTPUT);

/** Dedupe by angle key, preserving order, capped at `max`. */
function capAngles(agents: AgentConfig[], max: number): AgentConfig[] {
  const seen = new Set<string>();
  const out: AgentConfig[] = [];
  for (const a of agents) {
    if (seen.has(a.angle)) continue;
    seen.add(a.angle);
    out.push(a);
    if (out.length >= max) break;
  }
  return out;
}

/** Resolve an explicit caller-provided angle list. Always keeps the baseline. */
function resolveRequestedAngles(requested: string[], floor: AgentConfig[]): AgentConfig[] {
  const baseline = floor.filter((a) => a.angle === "architect" || a.angle === "senior-dev");
  const extra = requested
    .filter((a) => a in ALL_ANGLE_LABELS)
    .map((a) => ({ angle: a, label: ALL_ANGLE_LABELS[a] }));
  return capAngles([...baseline, ...extra], MAX_ANGLES);
}

/** Run the triage router (one cheap Kimi session) to pick content-driven angles.
 *  Returns [] on any failure — the floor still reviews, so this degrades gracefully. */
async function routeExtraAngles(cwd: string, diffCmd: string): Promise<AgentConfig[]> {
  let prompt: string;
  try {
    prompt = await loadAnglePrompt("router");
  } catch (err) {
    logger.error({ tool: "review", error: String(err) }, "router prompt load failed");
    return [];
  }
  prompt = prompt.replace("[GIT_DIFF_COMMAND]", `Run: \`${diffCmd}\``);

  const result = await runSession<z.infer<typeof ROUTER_OUTPUT>>({
    cwd,
    prompt,
    model: "Kimi-K2.6",
    jsonSchema: ROUTER_JSON_SCHEMA,
    maxTurns: 8,
    timeoutMs: 3 * 60 * 1000,
    readOnly: true,
    settingSources: "project",
    validate: zodValidator(ROUTER_OUTPUT),
  });

  if (!result.ok || !result.data) {
    logger.warn(
      { tool: "review", error: result.error },
      "router failed — using deterministic angles only",
    );
    return [];
  }

  const picked = result.data.angles.filter((a) => a in ROUTER_ANGLE_LABELS);
  logger.info(
    { tool: "review", routerAngles: picked, rationale: result.data.rationale },
    "router selected extra angles",
  );
  return picked.map((a) => ({ angle: a, label: ROUTER_ANGLE_LABELS[a] }));
}

// ── Core ───────────────────────────────────────────────────────────────────────

/** Multi-angle code review pipeline: data gather → parallel angle sessions →
 *  synthesis. Returns structured findings. Throws on git-diff failure (bad
 *  scope/not a repo) or synthesis failure; no-changes and all-angles-failed are
 *  returned as valid ReviewOutput verdicts. */
export async function runReview(rawParams: Record<string, unknown>): Promise<ReviewOutput> {
  const { cwd, scope, context, angles } = parseParams(REVIEW_INPUT, rawParams);
  if (!existsSync(cwd)) throw new Error(`Directory not found: ${cwd}`);

  const resolvedScope = scope ?? "uncommitted";
  validateScope(resolvedScope);

  const startMs = performance.now();
  logger.info(
    { event: "review.start", tool: "review", project: cwd, scope: resolvedScope },
    "review starting",
  );

  // ── Phase 1: Data gathering (parallel) ──────────────────────────────
  const diffCmd = gitDiffCommand(resolvedScope);
  const filesCmd = gitDiffFilesCommand(resolvedScope);

  const [diffResult, filesResult, fallowResult, coderabbitResult, packageJsonResult] =
    await Promise.all([
      shell(diffCmd, cwd),
      shell(filesCmd, cwd),
      shell(
        'which fallow >/dev/null 2>&1 && git remote -v 2>/dev/null | grep -q . && fallow audit --quiet 2>&1 || echo ""',
        cwd,
        60_000,
      ),
      shell(
        resolvedScope === "uncommitted"
          ? "which coderabbit >/dev/null 2>&1 && coderabbit review --prompt-only --type uncommitted 2>/dev/null || true"
          : resolvedScope === "head"
            ? "which coderabbit >/dev/null 2>&1 && coderabbit review --prompt-only --type committed 2>/dev/null || true"
            : `which coderabbit >/dev/null 2>&1 && coderabbit review --prompt-only --base ${resolvedScope} 2>/dev/null || true`,
        cwd,
        60_000,
      ),
      shell("cat package.json 2>/dev/null", cwd),
    ]);

  // A non-zero exit from `git diff` is a genuine failure (bad scope ref, not a
  // git repo, git missing) — NOT "no changes". Surface it; otherwise the empty
  // stdout below would be misread as a clean review (false positive).
  if (!diffResult.ok) {
    throw new Error(
      `git diff failed for scope "${resolvedScope}": ${diffResult.stdout.trim() || "no output"}`,
    );
  }

  if (!diffResult.stdout.trim()) {
    logger.info(
      {
        event: "review.done",
        tool: "review",
        project: cwd,
        durationMs: Math.round(performance.now() - startMs),
      },
      "review done (no changes)",
    );
    return {
      outcome: "clean",
      blocking: [],
      improvements: [],
      discussions: [],
      testGaps: [],
      summary: "No changes to review.",
    };
  }

  const changedFiles = filesResult.stdout.split("\n").filter(Boolean);
  let hasTestScript = false;
  try {
    const pkg = JSON.parse(packageJsonResult.stdout);
    hasTestScript = !!pkg?.scripts?.test;
  } catch {
    // no package.json or invalid — skip QA agent
  }

  const floorAgents = selectAgents(changedFiles, hasTestScript);

  const contextBlock = context
    ? `\n\n## Author Context\n\n> ${context}\n\nThis is the author's stated intent. Use it to evaluate whether the changes achieve the goal — not to justify shortcuts. If the implementation doesn't match the intent, that's a blocking finding.`
    : "";

  // ── Phase 1.5: Dynamic angle routing ─────
  const explicit = angles && angles.length > 0;
  const agents = explicit
    ? resolveRequestedAngles(angles, floorAgents)
    : capAngles([...floorAgents, ...(await routeExtraAngles(cwd, diffCmd))], MAX_ANGLES);

  logger.info(
    {
      tool: "review",
      project: cwd,
      agents: agents.map((a) => a.angle),
      changedFiles: changedFiles.length,
      routed: !explicit,
      hasFallow: !!fallowResult.stdout,
      hasCoderabbit: !!coderabbitResult.stdout,
    },
    "review agents selected",
  );

  // ── Phase 2: Angle reviews (parallel sessions) ──────────────────────
  const angleResults = await mapWithConcurrency(
    agents,
    ANGLE_CONCURRENCY,
    async (agent): Promise<AngleResult> => {
      let prompt: string;
      try {
        prompt = await loadAnglePrompt(agent.angle);
      } catch (err) {
        logger.error(
          { tool: "review", angle: agent.angle, error: String(err) },
          "prompt load failed",
        );
        return {
          angle: agent.angle,
          findings: [],
          failureReason: `prompt load failed: ${String(err)}`,
        };
      }

      prompt = prompt.replace("[GIT_DIFF_COMMAND]", `Run: \`${diffCmd}\``);
      prompt += contextBlock;

      const result = await runSession<AngleOutput>({
        cwd,
        prompt,
        model: "Kimi-K2.6",
        jsonSchema: ANGLE_JSON_SCHEMA,
        maxTurns: 60,
        timeoutMs: 15 * 60 * 1000,
        readOnly: true,
        settingSources: "user,project",
        validate: zodValidator(ANGLE_OUTPUT),
      });

      if (!result.ok) {
        logger.error(
          { tool: "review", angle: agent.angle, error: result.error },
          "angle session failed",
        );
        return { angle: agent.angle, findings: [], failureReason: result.error ?? "unknown error" };
      }

      logger.info(
        { tool: "review", angle: agent.angle, findings: result.data?.findings.length ?? 0 },
        "angle session done",
      );
      return { angle: agent.angle, findings: result.data?.findings ?? [] };
    },
  );

  const failedAngles = angleResults.filter((r) => r.failureReason);

  // ── Short-circuit: if EVERY angle failed, don't pretend a synthesis is meaningful ─
  if (failedAngles.length === agents.length) {
    logger.error(
      {
        event: "review.done",
        tool: "review",
        project: cwd,
        outcome: "needs-human",
        failedAngles: failedAngles.length,
        totalAngles: agents.length,
        durationMs: Math.round(performance.now() - startMs),
      },
      "review aborted — all angle sessions failed",
    );
    return {
      outcome: "needs-human",
      blocking: [],
      improvements: [],
      discussions: failedAngles.map((r) => ({
        file: "(review pipeline)",
        message: `${r.angle} session failed: ${r.failureReason}`,
        angle: r.angle,
      })),
      testGaps: [],
      summary: `All ${agents.length} specialist reviewers failed — no review was actually performed. Causes: ${failedAngles.map((r) => `${r.angle}: ${r.failureReason}`).join("; ")}. Do NOT treat this as approval.`,
    };
  }

  // ── Phase 3: Synthesis ───────────────────────────
  const synthesisPrompt = await loadAnglePrompt("synthesis");

  const angleBlock = angleResults
    .map((r) => {
      if (r.failureReason) {
        return `**${r.angle}**: ⚠️ SESSION FAILED — ${r.failureReason}. This reviewer did NOT examine the diff. Treat as missing input, not as approval.`;
      }
      if (r.findings.length === 0)
        return `**${r.angle}**: No findings (reviewer ran successfully and approved).`;
      return `**${r.angle}**:\n${JSON.stringify(r.findings, null, 2)}`;
    })
    .join("\n\n");

  const fallowBlock = fallowResult.stdout
    ? `fallow audit output:\n\`\`\`\n${fallowResult.stdout}\n\`\`\``
    : "fallow: not available or skipped.";

  const coderabbitBlock = coderabbitResult.stdout
    ? `CodeRabbit findings:\n\`\`\`\n${coderabbitResult.stdout}\n\`\`\``
    : "CodeRabbit: not available or skipped.";

  const finalPrompt = synthesisPrompt
    .replace("[ANGLE_RESULTS]", angleBlock)
    .replace("[FALLOW_RESULTS]", fallowBlock)
    .replace("[CODERABBIT_RESULTS]", coderabbitBlock);

  const synthesisResult = await runSession<ReviewOutput>({
    cwd,
    prompt: finalPrompt,
    model: "Kimi-K2.6",
    jsonSchema: REVIEW_JSON_SCHEMA,
    maxTurns: 20,
    timeoutMs: 10 * 60 * 1000,
    readOnly: true,
    settingSources: "user,project",
    validate: zodValidator(REVIEW_OUTPUT),
  });

  if (!synthesisResult.ok || !synthesisResult.data) {
    logger.error(
      {
        event: "review.done",
        tool: "review",
        project: cwd,
        durationMs: Math.round(performance.now() - startMs),
        error: synthesisResult.error,
      },
      "review synthesis failed",
    );
    throw new Error(synthesisResult.error ?? "review synthesis produced no result");
  }

  const data = synthesisResult.data;

  // Safety net: synthesis must not return "clean" when one or more angles failed.
  if (failedAngles.length > 0 && data.outcome === "clean") {
    data.outcome = "needs-human";
    for (const f of failedAngles) {
      data.discussions.push({
        file: "(review pipeline)",
        message: `${f.angle} session failed: ${f.failureReason} — this angle did not actually review the diff.`,
        angle: f.angle,
      });
    }
    data.summary = `Partial review: ${failedAngles.length}/${agents.length} reviewers failed (${failedAngles.map((r) => r.angle).join(", ")}). ${data.summary}`;
  }

  logger.info(
    {
      event: "review.done",
      tool: "review",
      project: cwd,
      outcome: data.outcome,
      blocking: data.blocking.length,
      improvements: data.improvements.length,
      discussions: data.discussions.length,
      testGaps: data.testGaps.length,
      failedAngles: failedAngles.length,
      totalAngles: agents.length,
      durationMs: Math.round(performance.now() - startMs),
    },
    "review done",
  );

  return data;
}
