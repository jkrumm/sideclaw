import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import { runSession, zodValidator } from "../../mcp/session-runner.ts";
import type { ProgressSink } from "../store.ts";
import { parseParams } from "./util.ts";

/** Resolve the Tavily key (env first, then the Keychain entry `make setup` caches).
 *  Exported so higher-order handlers (implement/review) can grant the same web-search
 *  capability to their workers without recursive MCP calls. */
export async function readTavilyKey(): Promise<string | null> {
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

// ── Input schema ─────────────────────────────────────────────────────────────

export const RESEARCH_INPUT = z.object({
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
});

export type ResearchParams = z.infer<typeof RESEARCH_INPUT>;

// ── Output schema — single source of truth ────────────────────────────────────

export const RESEARCH_OUTPUT = z.object({
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

export type ResearchOutput = z.infer<typeof RESEARCH_OUTPUT>;

// ── Depth profiles ──────────────────────────────────────────────────────────────

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

// ── Core ───────────────────────────────────────────────────────────────────────

/** Run a focused web research pass with cross-verification. Throws on failure. */
export async function runResearch(
  rawParams: Record<string, unknown>,
  onProgress?: ProgressSink,
): Promise<ResearchOutput> {
  const { query, cwd, depth } = parseParams(RESEARCH_INPUT, rawParams);
  const workDir = cwd ?? homedir();
  if (!existsSync(workDir)) throw new Error(`Directory not found: ${workDir}`);

  const resolvedDepth: Depth = depth ?? "standard";
  const profile = DEPTH_PROFILES[resolvedDepth];
  const prompt = await loadSkillPrompt(query, profile.directive);

  const tavilyKey = await readTavilyKey();

  const result = await runSession<ResearchOutput>({
    cwd: workDir,
    prompt,
    tool: "research",
    model: "DeepSeek-V4-Pro",
    jsonSchema: RESEARCH_JSON_SCHEMA,
    maxTurns: profile.maxTurns,
    timeoutMs: profile.timeoutMs,
    readOnly: true,
    extraEnv: tavilyKey ? { TAVILY_API_KEY: tavilyKey } : undefined,
    validate: zodValidator(RESEARCH_OUTPUT),
    onActivity: onProgress,
  });

  if (!result.ok || !result.data) {
    throw new Error(result.error ?? "research produced no result");
  }
  return result.data;
}
