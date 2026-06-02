import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSession, mcpProgressCallback, zodValidator } from "../session-runner.ts";
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
});

const OTEL_JSON_SCHEMA = z.toJSONSchema(OTEL_OUTPUT);

type OtelOutput = z.infer<typeof OTEL_OUTPUT>;

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

      const startMs = performance.now();
      logger.info(
        {
          event: "mcp.tool.start",
          tool: "otel",
          project: workDir,
          environment,
          investigation: investigation.slice(0, 120),
        },
        "otel starting",
      );

      const result = await runSession<OtelOutput>({
        cwd: workDir,
        prompt,
        tool: "otel",
        model: "DeepSeek-V4-Pro",
        jsonSchema: OTEL_JSON_SCHEMA,
        maxTurns: 20,
        timeoutMs: 8 * 60 * 1000,
        readOnly: true,
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

      logger.info(
        {
          event: "mcp.tool.end",
          tool: "otel",
          project: workDir,
          status: result.data?.status,
          findings: result.data?.findings.length ?? 0,
          durationMs: Math.round(performance.now() - startMs),
        },
        "otel done",
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result.data) }],
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- result.data is guaranteed here: early return above handles result.error case
        structuredContent: result.data!,
      };
    },
  );
}
