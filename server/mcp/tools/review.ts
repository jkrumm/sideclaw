import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSession, mcpProgressCallback } from "../session-runner.ts";
import { logger } from "../logger.ts";

// ── Output schema — single source of truth ────────────────────────────────────

const FINDING = z.object({
  file: z.string().describe("Relative file path from repo root."),
  line: z.number().optional().describe("Line number, if identifiable."),
  message: z.string().describe("What the issue is, why it matters, and how to fix it."),
  angle: z
    .string()
    .describe(
      "Which reviewer caught this: architect | senior-dev | frontend | backend | typescript | qa | coderabbit | fallow",
    ),
});

const REVIEW_OUTPUT = z.object({
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

type ReviewOutput = z.infer<typeof REVIEW_OUTPUT>;

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

function gitDiffCommand(scope: string): string {
  switch (scope) {
    case "uncommitted":
      return 'diff=$(git diff --cached); [ -z "$diff" ] && diff=$(git diff); echo "$diff"';
    case "head":
      return "git show HEAD";
    default:
      if (scope.startsWith("/") || scope.includes(".")) {
        return `git diff -- ${scope}`;
      }
      return `git show ${scope}`;
  }
}

function gitDiffFilesCommand(scope: string): string {
  switch (scope) {
    case "uncommitted":
      return 'files=$(git diff --cached --name-only); [ -z "$files" ] && files=$(git diff --name-only); echo "$files"';
    case "head":
      return "git show HEAD --name-only --format=''";
    default:
      if (scope.startsWith("/") || scope.includes(".")) {
        return `git diff --name-only -- ${scope}`;
      }
      return `git show ${scope} --name-only --format=''`;
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

  if (hasFrontend) {
    agents.push({ angle: "frontend", label: "Frontend Expert" });
  }

  if (hasBackend) {
    agents.push({ angle: "backend", label: "Backend Expert" });
  }

  if (hasTypeScript) {
    agents.push({ angle: "typescript", label: "TypeScript Expert" });
  }

  if (hasTestScript) {
    agents.push({ angle: "qa", label: "QA Engineer" });
  }

  return agents;
}

// ── Tool registration ──────────────────────────────────────────────────────────

export function registerReviewTool(server: McpServer): void {
  server.registerTool(
    "review",
    {
      title: "Code Review",
      description: `Run a deep multi-angle code review with specialist reviewers (architecture, code quality, TypeScript, frontend, backend, QA) and return structured findings classified by action level.

WHEN TO CALL: before committing, before creating a PR, or when asked to review code quality.
READ-ONLY: never modifies files. Safe to retry.
CWD: absolute path of the repo to review — not necessarily this session's CWD.
SCOPE: what to review — "uncommitted" (default, staged+unstaged), "head" (last commit), or a git ref/path.
CONTEXT: optional background on what the changes are trying to accomplish. Helps catch "doesn't achieve the goal" issues.
OUTPUT: check \`outcome\` first — "clean" (nothing to do), "actionable" (blocking + improvements + testGaps to apply), or "needs-human" (has discussions requiring decision). \`blocking\` must be fixed. \`improvements\` should be applied by the implementation agent. \`discussions\` need human review. \`testGaps\` list missing test scenarios.`,
      inputSchema: {
        cwd: z
          .string()
          .describe(
            "Absolute path to the git repo root to review. Must be an existing git repository.",
          ),
        scope: z
          .string()
          .optional()
          .describe(
            'What to review. "uncommitted" (default) = staged + unstaged changes. "head" = last commit. Or a git ref like "HEAD~3" or a file path.',
          ),
        context: z
          .string()
          .optional()
          .describe(
            'Factual description of the changes\' intent (e.g. "add MCP review tool"). Helps catch goal-mismatch bugs. Omit if the diff is self-explanatory.',
          ),
      },
      outputSchema: REVIEW_OUTPUT.shape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd, scope, context }, extra) => {
      if (!existsSync(cwd)) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: `Directory not found: ${cwd}` }) },
          ],
          isError: true,
        };
      }

      const resolvedScope = scope ?? "uncommitted";
      try {
        validateScope(resolvedScope);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }

      const startMs = performance.now();
      logger.info(
        { event: "mcp.tool.start", tool: "review", project: cwd, scope: resolvedScope },
        "review starting",
      );

      // ── Phase 1: Data gathering (parallel) ──────────────────────────────

      const diffCmd = gitDiffCommand(resolvedScope);
      const filesCmd = gitDiffFilesCommand(resolvedScope);

      const [diffResult, filesResult, fallowResult, coderabbitResult, packageJsonResult] =
        await Promise.all([
          shell(diffCmd, cwd),
          shell(filesCmd, cwd),
          // fallow audit (skip if not installed or no remote)
          shell(
            'which fallow >/dev/null 2>&1 && git remote -v 2>/dev/null | grep -q . && fallow audit --quiet 2>&1 || echo ""',
            cwd,
            60_000,
          ),
          // CodeRabbit (skip if not installed)
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

      if (!diffResult.ok || !diffResult.stdout) {
        const emptyResult: ReviewOutput = {
          outcome: "clean",
          blocking: [],
          improvements: [],
          discussions: [],
          testGaps: [],
          summary: "No changes to review.",
        };
        logger.info(
          {
            event: "mcp.tool.end",
            tool: "review",
            project: cwd,
            passed: true,
            durationMs: Math.round(performance.now() - startMs),
          },
          "review done (no changes)",
        );
        return {
          content: [{ type: "text", text: JSON.stringify(emptyResult) }],
          structuredContent: emptyResult,
        };
      }

      // Parse changed files and detect project characteristics
      const changedFiles = filesResult.stdout.split("\n").filter(Boolean);
      let hasTestScript = false;
      try {
        const pkg = JSON.parse(packageJsonResult.stdout);
        hasTestScript = !!pkg?.scripts?.test;
      } catch {
        // no package.json or invalid — skip QA agent
      }

      const agents = selectAgents(changedFiles, hasTestScript);
      logger.info(
        {
          tool: "review",
          project: cwd,
          agents: agents.map((a) => a.angle),
          changedFiles: changedFiles.length,
          hasFallow: !!fallowResult.stdout,
          hasCoderabbit: !!coderabbitResult.stdout,
        },
        "review agents selected",
      );

      // ── Phase 2: Angle reviews (parallel haiku sessions) ────────────────

      const onProgress = mcpProgressCallback(extra);
      // Centralized heartbeat — one interval for the entire pipeline (phases 2+3).
      // Individual runSession() calls intentionally omit onProgress because this
      // handler-level heartbeat already resets the MCP client timeout. Avoids N
      // overlapping heartbeats from parallel sessions.
      let heartbeatTick = 0;
      const heartbeatHandle = onProgress
        ? setInterval(() => {
            heartbeatTick++;
            const elapsed = heartbeatTick * 15;
            onProgress(heartbeatTick, 0, `Review in progress (${elapsed}s elapsed)`);
          }, 15_000)
        : null;

      const contextBlock = context
        ? `\n\n## Author Context\n\n> ${context}\n\nThis is the author's stated intent. Use it to evaluate whether the changes achieve the goal — not to justify shortcuts. If the implementation doesn't match the intent, that's a blocking finding.`
        : "";

      try {
        // ── Phase 2 + 3 wrapped in try-finally to guarantee heartbeat cleanup ──

        const anglePromises = agents.map(async (agent) => {
          let prompt: string;
          try {
            prompt = await loadAnglePrompt(agent.angle);
          } catch (err) {
            logger.error(
              { tool: "review", angle: agent.angle, error: String(err) },
              "prompt load failed",
            );
            return { angle: agent.angle, findings: [] as AngleOutput["findings"] };
          }

          // Inject the git diff command into the prompt
          prompt = prompt.replace("[GIT_DIFF_COMMAND]", `Run: \`${diffCmd}\``);
          prompt += contextBlock;

          const result = await runSession<AngleOutput>({
            cwd,
            prompt,
            model: "claude-haiku-4-5-20251001",
            jsonSchema: ANGLE_JSON_SCHEMA,
            maxTurns: 10,
            timeoutMs: 5 * 60 * 1000,
          });

          if (!result.ok) {
            logger.error(
              { tool: "review", angle: agent.angle, error: result.error },
              "angle session failed",
            );
            return { angle: agent.angle, findings: [] as AngleOutput["findings"] };
          }

          logger.info(
            { tool: "review", angle: agent.angle, findings: result.data?.findings.length ?? 0 },
            "angle session done",
          );
          return { angle: agent.angle, findings: result.data?.findings ?? [] };
        });

        const angleResults = await Promise.all(anglePromises);

        // ── Phase 3: Synthesis (sonnet session) ───────────────────────────

        const synthesisPrompt = await loadAnglePrompt("synthesis");

        // Build angle results block
        const angleBlock = angleResults
          .map((r) => {
            if (r.findings.length === 0) return `**${r.angle}**: No findings.`;
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
          model: "claude-sonnet-4-6",
          jsonSchema: REVIEW_JSON_SCHEMA,
          maxTurns: 5,
          timeoutMs: 5 * 60 * 1000,
        });

        if (!synthesisResult.ok) {
          logger.error(
            {
              event: "mcp.tool.end",
              tool: "review",
              project: cwd,
              passed: false,
              durationMs: Math.round(performance.now() - startMs),
              error: synthesisResult.error,
            },
            "review synthesis failed",
          );
          return {
            content: [{ type: "text", text: JSON.stringify({ error: synthesisResult.error }) }],
            isError: true,
          };
        }

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guaranteed by ok check + early return above
        const data = synthesisResult.data!;
        const hasBlocking = data.blocking.length > 0;
        logger.info(
          {
            event: "mcp.tool.end",
            tool: "review",
            project: cwd,
            passed: !hasBlocking,
            outcome: data.outcome,
            blocking: data.blocking.length,
            improvements: data.improvements.length,
            discussions: data.discussions.length,
            testGaps: data.testGaps.length,
            durationMs: Math.round(performance.now() - startMs),
          },
          "review done",
        );

        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        };
      } finally {
        if (heartbeatHandle) clearInterval(heartbeatHandle);
      }
    },
  );
}
