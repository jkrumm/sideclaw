import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSession, mcpProgressCallback } from "../session-runner.ts";
import { logger } from "../logger.ts";

/** Resolve the Tavily key (env first, then the Keychain entry `make setup` caches). */
async function readTavilyKey(): Promise<string | null> {
  if (process.env.TAVILY_API_KEY) return process.env.TAVILY_API_KEY;
  try {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", "tavily-api-key", "-w"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const trimmed = out.trim();
    return code === 0 && trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

// ── Output schema — single source of truth ────────────────────────────────────

const RESEARCH_OUTPUT = z.object({
  summary: z.string().describe("2-3 sentence answer to the query."),
  findings: z
    .array(
      z.object({
        claim: z.string(),
        source: z.string().describe("URL where this claim was verified."),
      }),
    )
    .describe("Verified findings backing the summary. Each tied to a source URL."),
  recommendation: z
    .string()
    .describe("Specific actionable next step — version numbers, code, or concrete decision."),
  confidence: z.enum(["high", "medium", "low"]).describe("Reflects source agreement and recency."),
  sources: z.array(z.string()).describe("All URLs consulted, deduplicated."),
});

const RESEARCH_JSON_SCHEMA = z.toJSONSchema(RESEARCH_OUTPUT);

type ResearchOutput = z.infer<typeof RESEARCH_OUTPUT>;

// ── Skill prompt loader ────────────────────────────────────────────────────────

async function loadSkillPrompt(query: string): Promise<string> {
  const skillPath = join(import.meta.dir, "../../skills/research.md");
  if (!existsSync(skillPath)) {
    throw new Error(`research skill prompt not found at ${skillPath}`);
  }
  const template = await Bun.file(skillPath).text();
  return template.replace("{{QUERY}}", query);
}

// ── Tool registration ──────────────────────────────────────────────────────────

export function registerResearchTool(server: McpServer): void {
  server.registerTool(
    "research",
    {
      title: "Technical Research",
      description: `Run a focused web research pass — Context7 for library docs, WebSearch + WebFetch for general queries, cross-verified across 2+ sources. Returns structured findings with confidence.

WHEN TO CALL: verifying library API/version, evaluating an architecture choice, checking recent ecosystem state (post-training-cutoff), or any "is X still true / what's current best practice" question.
READ-ONLY: never modifies files. Safe to retry.
ISOLATION: heavy fetch content stays in the worker; only the structured findings return to the caller.
OUTPUT: inspect \`confidence\` first. Low confidence = sources disagreed or were stale; treat \`recommendation\` as tentative.`,
      inputSchema: {
        query: z
          .string()
          .min(3)
          .describe(
            "The technical research question. Be specific — include library name, version constraints, or platform context where relevant.",
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            "Optional working directory for the spawned worker. Defaults to $HOME. Only matters if research touches project-local Context7 cache.",
          ),
      },
      outputSchema: RESEARCH_OUTPUT.shape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: false,
      },
    },
    async ({ query, cwd }, extra) => {
      const workDir = cwd ?? homedir();
      if (!existsSync(workDir)) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: `Directory not found: ${workDir}` }) },
          ],
          isError: true,
        };
      }

      let prompt: string;
      try {
        prompt = await loadSkillPrompt(query);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }

      const startMs = performance.now();
      logger.info(
        { event: "mcp.tool.start", tool: "research", query: query.slice(0, 120) },
        "research starting",
      );

      const tavilyKey = await readTavilyKey();
      if (!tavilyKey) {
        logger.warn(
          { tool: "research" },
          "TAVILY_API_KEY not found (env or Keychain) — web search will be unavailable",
        );
      }

      const result = await runSession<ResearchOutput>({
        cwd: workDir,
        prompt,
        model: "Kimi-K2.6",
        jsonSchema: RESEARCH_JSON_SCHEMA,
        maxTurns: 20,
        timeoutMs: 8 * 60 * 1000,
        readOnly: true,
        extraEnv: tavilyKey ? { TAVILY_API_KEY: tavilyKey } : undefined,
        onProgress: mcpProgressCallback(extra),
      });

      if (!result.ok) {
        logger.error(
          {
            event: "mcp.tool.end",
            tool: "research",
            durationMs: Math.round(performance.now() - startMs),
            error: result.error,
          },
          "research failed",
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }

      logger.info(
        {
          event: "mcp.tool.end",
          tool: "research",
          confidence: result.data?.confidence,
          sources: result.data?.sources.length ?? 0,
          durationMs: Math.round(performance.now() - startMs),
        },
        "research done",
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result.data) }],
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- result.data is guaranteed here: early return above handles result.error case
        structuredContent: result.data!,
      };
    },
  );
}
