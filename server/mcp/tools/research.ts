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

// ── Depth profiles ──────────────────────────────────────────────────────────────
// The orchestrator maps the user's phrasing ("quick research" / "deep research") to a
// depth; each scales the worker's turn/time budget and its search strategy.

const DEPTH_PROFILES = {
  quick: {
    maxTurns: 6,
    timeoutMs: 3 * 60 * 1000,
    directive:
      "QUICK pass — favor speed and minimal credits. Run ONE basic Tavily search and answer from its `answer` + result snippets. Fetch at most one page, and only if the snippets are insufficient. One or two sources is acceptable; set `confidence` accordingly.",
  },
  standard: {
    maxTurns: 20,
    timeoutMs: 8 * 60 * 1000,
    directive:
      "STANDARD pass — one basic Tavily search, then readability-cli on the 2-3 most relevant URLs. Cross-verify across at least 2 independent sources.",
  },
  deep: {
    maxTurns: 40,
    timeoutMs: 15 * 60 * 1000,
    directive:
      "DEEP pass — be thorough. Use `advanced` search depth and more results; readability-cli on 4-6 URLs across distinct domains; consult Context7 for any libraries involved. Cross-verify across 3+ independent sources and explicitly call out disagreements and version-specific caveats.",
  },
} as const;

type Depth = keyof typeof DEPTH_PROFILES;

// ── Skill prompt loader ────────────────────────────────────────────────────────

async function loadSkillPrompt(query: string, depthDirective: string): Promise<string> {
  const skillPath = join(import.meta.dir, "../../skills/research.md");
  if (!existsSync(skillPath)) {
    throw new Error(`research skill prompt not found at ${skillPath}`);
  }
  const template = await Bun.file(skillPath).text();
  return template.replace("{{QUERY}}", query).replace("{{DEPTH}}", depthDirective);
}

// ── Tool registration ──────────────────────────────────────────────────────────

export function registerResearchTool(server: McpServer): void {
  server.registerTool(
    "research",
    {
      title: "Technical Research",
      description: `Run a focused web research pass — Context7 for library docs, Tavily search + readability-cli extraction, cross-verified across multiple sources. Caller controls depth. Returns structured findings with confidence.

WHEN TO CALL: verifying library API/version, evaluating an architecture choice, checking recent ecosystem state (post-training-cutoff), or any "is X still true / what's current best practice" question.
DEPTH: set \`depth\` from the user's ask — "quick research" → quick, "deep research" → deep, otherwise standard.
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
        depth: z
          .enum(["quick", "standard", "deep"])
          .optional()
          .describe(
            'Research depth — map from the user\'s ask. "quick" = one basic search, answer from snippets (fast, ~1 credit, ≤3 min). "standard" (default) = search + verify 2-3 sources (≤8 min). "deep" = advanced search, 3+ sources, Context7, thorough (≤15 min).',
          ),
      },
      outputSchema: RESEARCH_OUTPUT.shape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: false,
      },
    },
    async ({ query, cwd, depth }, extra) => {
      const workDir = cwd ?? homedir();
      if (!existsSync(workDir)) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: `Directory not found: ${workDir}` }) },
          ],
          isError: true,
        };
      }

      const resolvedDepth: Depth = depth ?? "standard";
      const profile = DEPTH_PROFILES[resolvedDepth];

      let prompt: string;
      try {
        prompt = await loadSkillPrompt(query, profile.directive);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }

      const startMs = performance.now();
      logger.info(
        {
          event: "mcp.tool.start",
          tool: "research",
          depth: resolvedDepth,
          query: query.slice(0, 120),
        },
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
        maxTurns: profile.maxTurns,
        timeoutMs: profile.timeoutMs,
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
