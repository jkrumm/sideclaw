import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpProgressCallback, runSession, WORKER_MODEL, zodValidator } from "../session-runner.ts";
import { logger } from "../logger.ts";

// ── Output schema — single source of truth ────────────────────────────────────

const OTEL_OUTPUT = z.object({
  status: z
    .enum(["healthy", "degraded", "errors"])
    .describe("Overall health of the observed system."),
  environment: z.enum(["local", "prod"]).describe("The environment that was queried."),
  timeRange: z.string().describe("The window actually queried (e.g. 'last 2h')."),
  findings: z
    .array(
      z.object({
        service: z.string().describe("Service name the finding relates to."),
        summary: z.string().describe("Short human-readable description of the issue."),
        severity: z.enum(["info", "warn", "error"]).describe("Severity level of the finding."),
        evidence: z
          .string()
          .optional()
          .describe("Trace ID, log excerpt, or other supporting evidence."),
      }),
    )
    .describe("Key findings from the observability data."),
  recommendations: z
    .array(z.string())
    .describe("Concrete next steps to investigate or remediate issues."),
  // Set by the tool handler after the session completes, never by the worker — the whole
  // point is that the caller can trust it even if the model never mentions its own tool
  // set. Optional in the schema so a worker that (correctly) never touches this field
  // still validates; the handler always fills it in before returning.
  hyperdx: z
    .string()
    .optional()
    .describe(
      "Provenance for the query path: 'connected' if the worker had the HyperDX MCP tools, " +
        "or 'unavailable (<reason>)' if the verdict came from query.py/raw SQL only.",
    ),
});

const OTEL_JSON_SCHEMA = z.toJSONSchema(OTEL_OUTPUT);

type OtelOutput = z.infer<typeof OTEL_OUTPUT>;

// ── HyperDX MCP credential resolution ──────────────────────────────────────────
//
// ClickStack/HyperDX ships a built-in MCP server (`POST <base>/api/mcp`, stateless
// Streamable HTTP, bearer = the HyperDX user access key). Wiring it into the worker's
// own tool set (rather than only the query.py fallback) lets it use the server's
// builder tools (list_sources/describe_source/query/timeseries/table/search/...)
// instead of hand-rolled SQL. Resolution fails soft: if no key resolves, the worker
// still runs — just without the MCP — and `hyperdx` in the output says why.

interface HyperdxConfig {
  base: string;
  key: string;
}

type HyperdxResolution = { ok: true; config: HyperdxConfig } | { ok: false; reason: string };

const LOCAL_ENV_PATH = join(homedir(), ".config", "hyperdx", "local.env");
const LOCAL_BASE = "http://localhost:7707";
const PROD_BASE = "https://hyperdx.jkrumm.com";
// Mirrors the SECRETS_RUN/GITHUB_TOKEN_REF pattern in dispatch-git.ts: fixed path (where
// `make setup` symlinks the shim), existsSync gate before ever spawning it. Never call
// `op` directly here — on the headless mini a bare `op` hangs on a biometric prompt no
// one can answer; `secrets-run` fails closed against the offline cache instead.
const SECRETS_RUN = join(homedir(), ".local", "bin", "secrets-run");
const PROD_KEY_REF = "op://vps/clickstack/AGENT_ACCESS_KEY";

/** Mutating HyperDX MCP tools, namespaced as Claude Code exposes them
 * (`mcp__<server>__<tool>`). Passed as `extraDisallowedTools` alongside `readOnly: true`
 * so the otel worker can query but never write a dashboard/alert/webhook/saved search.
 * Listed explicitly rather than as a glob — the CLI's `--disallowedTools` example syntax
 * (`Bash(git *)`) is command-pattern matching, not confirmed to glob plain MCP tool names,
 * and an unknown tool name is silently ignored (see session-runner.ts), so listing a few
 * that don't exist in a given ClickStack version costs nothing. */
const HYPERDX_MUTATING_TOOLS = [
  "mcp__hyperdx__clickstack_save_source",
  "mcp__hyperdx__clickstack_delete_source",
  "mcp__hyperdx__clickstack_save_webhook",
  "mcp__hyperdx__clickstack_delete_webhook",
  "mcp__hyperdx__clickstack_save_alert",
  "mcp__hyperdx__clickstack_delete_alert",
  "mcp__hyperdx__clickstack_save_dashboard",
  "mcp__hyperdx__clickstack_patch_dashboard",
  "mcp__hyperdx__clickstack_delete_dashboard",
  "mcp__hyperdx__clickstack_save_saved_search",
  "mcp__hyperdx__clickstack_delete_saved_search",
];

async function resolveLocalHyperdxConfig(): Promise<HyperdxResolution> {
  if (!existsSync(LOCAL_ENV_PATH)) {
    return { ok: false, reason: `${LOCAL_ENV_PATH} not found` };
  }
  const text = await Bun.file(LOCAL_ENV_PATH).text();
  const key = text.match(/^HYPERDX_LOCAL_ACCESS_KEY=(.+)$/m)?.[1]?.trim();
  if (!key) {
    return { ok: false, reason: `HYPERDX_LOCAL_ACCESS_KEY not set in ${LOCAL_ENV_PATH}` };
  }
  return { ok: true, config: { base: LOCAL_BASE, key } };
}

async function resolveProdHyperdxConfig(): Promise<HyperdxResolution> {
  const fromEnv = process.env.HYPERDX_PROD_ACCESS_KEY?.trim();
  if (fromEnv) return { ok: true, config: { base: PROD_BASE, key: fromEnv } };

  if (!existsSync(SECRETS_RUN)) {
    return {
      ok: false,
      reason: "HYPERDX_PROD_ACCESS_KEY unset and secrets-run not on PATH",
    };
  }

  const proc = Bun.spawn([SECRETS_RUN, "read", PROD_KEY_REF], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
  try {
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const key = stdout.trim();
    if (code === 0 && key) return { ok: true, config: { base: PROD_BASE, key } };
    return { ok: false, reason: `secrets-run could not resolve ${PROD_KEY_REF}` };
  } catch (err) {
    return {
      ok: false,
      reason: `secrets-run error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveHyperdxConfig(environment: "local" | "prod"): Promise<HyperdxResolution> {
  return environment === "local" ? resolveLocalHyperdxConfig() : resolveProdHyperdxConfig();
}

function buildHyperdxMcpConfig(config: HyperdxConfig): Record<string, unknown> {
  return {
    hyperdx: {
      type: "http",
      url: `${config.base}/api/mcp`,
      headers: { Authorization: `Bearer ${config.key}` },
    },
  };
}

// ── Skill prompt loader ────────────────────────────────────────────────────────

async function loadSkillPrompt(investigation: string, environment: string): Promise<string> {
  const skillPath = join(import.meta.dir, "../../skills/otel.md");
  if (!existsSync(skillPath)) {
    throw new Error(`otel skill prompt not found at ${skillPath}`);
  }
  const template = await Bun.file(skillPath).text();
  return template
    .replace("{{INVESTIGATION}}", investigation)
    .replace("{{ENVIRONMENT}}", environment);
}

// ── Tool registration ──────────────────────────────────────────────────────────

export function registerOtelTool(server: McpServer): void {
  server.registerTool(
    "otel",
    {
      title: "Observability Query",
      description: `Query OpenTelemetry traces, logs, and metrics in ClickHouse (HyperDX/ClickStack) and return structured findings.

WHEN TO CALL: investigating application errors, slow or missing traces, log anomalies, service health issues, or any observability question in local dev or VPS production.
READ-ONLY: never modifies files or data. Only reads from ClickHouse.
CWD: optional working directory for the spawned worker. Defaults to $HOME.
OUTPUT: inspect \`status\` first. "errors" means active error spans/logs were found; "degraded" means elevated latency or warnings; "healthy" means data is flowing normally. Review \`findings\` and \`recommendations\` for details.`,
      inputSchema: {
        investigation: z
          .string()
          .min(3)
          .describe(
            "What to investigate. Be specific — include service name, error message, trace ID, symptom, or time range if known.",
          ),
        environment: z
          .enum(["local", "prod"])
          .describe(
            "Which environment to query — 'local' (localhost:8123) or 'prod' (via SSH to VPS).",
          ),
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory for the spawned worker. Defaults to $HOME."),
      },
      outputSchema: OTEL_OUTPUT.shape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: false,
      },
    },
    async ({ investigation, environment, cwd }, extra) => {
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
        prompt = await loadSkillPrompt(investigation, environment);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }

      const hyperdxResolution = await resolveHyperdxConfig(environment);
      const mcpServers = hyperdxResolution.ok
        ? buildHyperdxMcpConfig(hyperdxResolution.config)
        : undefined;
      const hyperdxStatus = hyperdxResolution.ok
        ? "connected"
        : `unavailable (${hyperdxResolution.reason})`;

      const startMs = performance.now();
      logger.info(
        {
          event: "mcp.tool.start",
          tool: "otel",
          project: workDir,
          environment,
          investigation: investigation.slice(0, 120),
          hyperdx: hyperdxStatus,
        },
        "otel starting",
      );

      const result = await runSession<OtelOutput>({
        cwd: workDir,
        prompt,
        tool: "otel",
        model: WORKER_MODEL,
        jsonSchema: OTEL_JSON_SCHEMA,
        maxTurns: 20,
        timeoutMs: 8 * 60 * 1000,
        readOnly: true,
        mcpServers,
        extraDisallowedTools: HYPERDX_MUTATING_TOOLS,
        settingSources: "project",
        validate: zodValidator(OTEL_OUTPUT),
        onProgress: mcpProgressCallback(extra),
      });

      if (!result.ok) {
        logger.error(
          {
            event: "mcp.tool.end",
            tool: "otel",
            project: workDir,
            durationMs: Math.round(performance.now() - startMs),
            error: result.error,
          },
          "otel failed",
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
          isError: true,
        };
      }

      // hyperdx provenance is set here, never trusted from the worker's own JSON — a
      // model that never noticed its tool set was empty is not a reliable narrator of
      // that fact. This is the harness's own resolution result from above.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- result.data is guaranteed here: early return above handles result.error case
      const output: OtelOutput = { ...result.data!, hyperdx: hyperdxStatus };

      logger.info(
        {
          event: "mcp.tool.end",
          tool: "otel",
          project: workDir,
          status: output.status,
          findings: output.findings.length,
          hyperdx: hyperdxStatus,
          durationMs: Math.round(performance.now() - startMs),
        },
        "otel done",
      );
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}
