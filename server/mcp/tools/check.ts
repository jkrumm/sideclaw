import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSession } from "../session-runner.ts";
import { logger } from "../logger.ts";

// ── Output schema — single source of truth ────────────────────────────────────
// Both the MCP typed contract (outputSchema) and the claude --json-schema flag
// are derived from this definition. Edit here only.

const CHECK_OUTPUT = z.object({
  passed: z.boolean().describe("True only if every step passed."),
  steps: z.array(z.object({
    name: z.string().describe("Step name: format | lint | typecheck | test | fallow"),
    passed: z.boolean(),
    errors: z.array(z.string()).optional().describe("Error lines. Only present when passed is false."),
  })).describe("Only steps that were actually run (skipped if script absent)."),
  summary: z.string().describe("One-line result, e.g. 'All 3 steps passed' or '1/3 failed: lint (5 errors)'."),
});

// JSON schema for --json-schema CLI flag — derived from Zod, no manual sync needed
const CHECK_JSON_SCHEMA = z.toJSONSchema(CHECK_OUTPUT);

type CheckOutput = z.infer<typeof CHECK_OUTPUT>;

// ── Skill prompt loader ────────────────────────────────────────────────────────

async function loadSkillPrompt(): Promise<string> {
  const skillPath = join(import.meta.dir, "../../skills/check.md");
  if (!existsSync(skillPath)) {
    throw new Error(`check skill prompt not found at ${skillPath}`);
  }
  return Bun.file(skillPath).text();
}

// ── Tool registration ──────────────────────────────────────────────────────────

export function registerCheckTool(server: McpServer): void {
  server.registerTool(
    "check",
    {
      title: "Code Quality Check",
      description: `Run all available validation steps (format, lint, typecheck, test, fallow static analysis) in a git repo and return structured pass/fail results.

WHEN TO CALL: before committing, before creating a PR, or when asked to validate code quality.
READ-ONLY: never modifies files. Safe to retry.
CWD: pass the absolute path of the repo being validated — not necessarily this session's CWD.
OUTPUT: check \`passed\` first. If false, inspect \`steps[n].errors\` for failing error lines. \`summary\` is a one-line human-readable result.
STEPS: only runs scripts present in package.json — skips unavailable ones silently.`,
      inputSchema: {
        cwd: z.string().describe(
          "Absolute path to the git repo root to validate. Must be an existing git repository. Supports git worktrees."
        ),
      },
      outputSchema: CHECK_OUTPUT.shape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd }) => {
      if (!existsSync(cwd)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Directory not found: ${cwd}` }) }],
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

      const startMs = performance.now();
      logger.info({ event: "mcp.tool.start", tool: "check", project: cwd }, "check starting");

      const result = await runSession<CheckOutput>({
        cwd,
        prompt,
        model: "claude-haiku-4-5-20251001",
        jsonSchema: CHECK_JSON_SCHEMA,
        maxTurns: 30,
        timeoutMs: 10 * 60 * 1000,
      });

      if (!result.ok) {
        logger.error(
          { event: "mcp.tool.end", tool: "check", project: cwd, passed: false, durationMs: Math.round(performance.now() - startMs), error: result.error },
          "check failed",
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }

      logger.info(
        { event: "mcp.tool.end", tool: "check", project: cwd, passed: result.data?.passed, durationMs: Math.round(performance.now() - startMs) },
        "check done",
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result.data) }],
        structuredContent: result.data!,
      };
    },
  );
}
