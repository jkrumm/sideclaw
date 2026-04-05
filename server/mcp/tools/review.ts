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
  message: z.string().describe("What the issue is and how to fix it."),
  rule: z
    .string()
    .optional()
    .describe(
      "Category: architecture | kiss | typescript | race-condition | error-handling | security | performance | bug | dead-code",
    ),
});

const REVIEW_OUTPUT = z.object({
  blocking: z
    .array(FINDING)
    .describe("Bugs, security issues, type errors — must fix before merging."),
  warnings: z
    .array(FINDING)
    .describe("KISS violations, missing error handling, coupling — should fix."),
  suggestions: z.array(FINDING).describe("Simplifications, style improvements — nice to fix."),
  testGaps: z
    .array(z.string())
    .describe("Missing test coverage areas, e.g. 'server/auth.ts — no test for expired token'."),
  summary: z
    .string()
    .describe(
      "1-2 sentence assessment of the changes, e.g. 'Clean feature addition. 1 blocking null-check bug, 2 KISS warnings.'",
    ),
});

const REVIEW_JSON_SCHEMA = z.toJSONSchema(REVIEW_OUTPUT);

type ReviewOutput = z.infer<typeof REVIEW_OUTPUT>;

// ── Skill prompt loader ────────────────────────────────────────────────────────

async function loadSkillPrompt(): Promise<string> {
  const skillPath = join(import.meta.dir, "../../skills/review.md");
  if (!existsSync(skillPath)) {
    throw new Error(`review skill prompt not found at ${skillPath}`);
  }
  return Bun.file(skillPath).text();
}

// ── Tool registration ──────────────────────────────────────────────────────────

export function registerReviewTool(server: McpServer): void {
  server.registerTool(
    "review",
    {
      title: "Code Review",
      description: `Run a multi-angle code review on changed files in a git repo and return structured findings grouped by severity.

WHEN TO CALL: before committing, before creating a PR, or when asked to review code quality.
READ-ONLY: never modifies files. Safe to retry.
CWD: absolute path of the repo to review — not necessarily this session's CWD.
SCOPE: what to review — "uncommitted" (default, staged+unstaged), "head" (last commit), or a git ref/path.
CONTEXT: optional background on what the changes are trying to accomplish. Helps the reviewer catch "doesn't achieve the goal" issues. Keep it factual — describe the intent (e.g. "add retry logic to API client"), not how you feel about it. Do NOT include justifications like "this is a quick fix" or "not important" — that biases the review. Omit if the diff speaks for itself.
OUTPUT: check \`blocking\` first — these must be fixed. Then \`warnings\` (should fix) and \`suggestions\` (nice to fix). \`testGaps\` lists missing test scenarios. \`summary\` is a 1-2 sentence assessment.`,
      inputSchema: {
        cwd: z
          .string()
          .describe(
            "Absolute path to the git repo root to review. Must be an existing git repository. Supports git worktrees.",
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
            'Factual description of the changes\' intent (e.g. "add MCP review tool following check.ts patterns"). Helps catch goal-mismatch bugs. Omit if the diff is self-explanatory. Do NOT include quality judgments or justifications — they bias the review.',
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

      let prompt: string;
      try {
        prompt = await loadSkillPrompt();
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }

      // Inject scope and context into prompt
      const resolvedScope = scope ?? "uncommitted";
      prompt = prompt.replace(/\[SCOPE\]/g, resolvedScope);
      prompt = context
        ? prompt.replace(
            /\[AUTHOR_CONTEXT_BLOCK\]/,
            `## Author Context\n\n> ${context}\n\nThis is the author's stated intent. Use it to evaluate whether the changes actually achieve the goal — not to justify shortcuts or lower your review bar. If the implementation doesn't match the intent, that's a blocking finding.`,
          )
        : prompt.replace(/\[AUTHOR_CONTEXT_BLOCK\]\n*/, "");

      const startMs = performance.now();
      logger.info(
        { event: "mcp.tool.start", tool: "review", project: cwd, scope: resolvedScope },
        "review starting",
      );

      const result = await runSession<ReviewOutput>({
        cwd,
        prompt,
        model: "claude-sonnet-4-6",
        jsonSchema: REVIEW_JSON_SCHEMA,
        maxTurns: 30,
        timeoutMs: 10 * 60 * 1000,
        onProgress: mcpProgressCallback(extra),
      });

      if (!result.ok) {
        logger.error(
          {
            event: "mcp.tool.end",
            tool: "review",
            project: cwd,
            passed: false,
            durationMs: Math.round(performance.now() - startMs),
            error: result.error,
          },
          "review failed",
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }

      const hasBlocking = (result.data?.blocking.length ?? 0) > 0;
      logger.info(
        {
          event: "mcp.tool.end",
          tool: "review",
          project: cwd,
          passed: !hasBlocking,
          durationMs: Math.round(performance.now() - startMs),
        },
        "review done",
      );

      return {
        content: [{ type: "text", text: JSON.stringify(result.data) }],
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- result.data is guaranteed here: early return above handles result.error case
        structuredContent: result.data!,
      };
    },
  );
}
