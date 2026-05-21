import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSession, mcpProgressCallback } from "../session-runner.ts";
import { logger } from "../logger.ts";

// ── Output schema — single source of truth ────────────────────────────────────

const IMPLEMENT_OUTPUT = z.object({
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

type ImplementOutput = z.infer<typeof IMPLEMENT_OUTPUT>;

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

// ── Tool registration ──────────────────────────────────────────────────────────

export function registerImplementTool(server: McpServer): void {
  server.registerTool(
    "implement",
    {
      title: "Implement Coding Task",
      description: `Delegate a scoped coding task to an EU worker (Kimi-K2.6 via the LiteLLM bridge) that edits files with full permissions, self-verifies against the repo's checks, and returns a structured report. Keeps the heavy implementation off your Max subscription.

WHEN TO CALL: when you (the orchestrator) have planned a concrete, self-contained implementation task and want to offload the actual edits. Provide a precise task — the worker is a capable but literal executor, not a planner.
SIDE EFFECTS: creates and edits files under \`cwd\` and runs the repo's validators. Does NOT commit, push, or branch.
CWD: absolute path of the target repo — not necessarily this session's CWD.
OUTPUT: check \`applied\` (were changes made) and \`checkPassed\` (did validation pass). \`filesChanged\` lists what changed; \`notes\` carries assumptions, pre-existing failures, and follow-ups. Review the diff yourself before committing.`,
      inputSchema: {
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
      },
      outputSchema: IMPLEMENT_OUTPUT.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ cwd, task, context }, extra) => {
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
        prompt = await loadSkillPrompt(task, context);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }

      const startMs = performance.now();
      logger.info(
        { event: "mcp.tool.start", tool: "implement", project: cwd, task: task.slice(0, 120) },
        "implement starting",
      );

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
        onProgress: mcpProgressCallback(extra),
      });

      if (!result.ok) {
        logger.error(
          {
            event: "mcp.tool.end",
            tool: "implement",
            project: cwd,
            durationMs: Math.round(performance.now() - startMs),
            error: result.error,
          },
          "implement failed",
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }

      logger.info(
        {
          event: "mcp.tool.end",
          tool: "implement",
          project: cwd,
          applied: result.data?.applied,
          checkPassed: result.data?.checkPassed,
          durationMs: Math.round(performance.now() - startMs),
        },
        "implement done",
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result.data) }],
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- result.data is guaranteed here: early return above handles result.error case
        structuredContent: result.data!,
      };
    },
  );
}
