import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OVERVIEW_INPUT } from "../../jobs/handlers/overview.ts";
import { registerJobSubmitTool } from "./_job-tool.ts";
import { describeRoute, routeFor } from "../../lib/routing.ts";

export function registerOverviewTool(server: McpServer): void {
  registerJobSubmitTool(server, {
    name: "overview",
    title: "Agent Fleet Overview",
    tool: "overview",
    inputSchema: OVERVIEW_INPUT.shape,
    annotations: { readOnlyHint: true, idempotentHint: false },
    description: `Enrich the deterministic agent snapshot (GET /api/agents) with one LLM recommendation per Claude Code agent on this Mac mini — a batched, single-call, prompt-only triage pass. Runs as a BACKGROUND JOB: this call returns a jobId immediately — it does NOT return the recommendations.

WHEN TO CALL: when a caller wants a fleet-wide "what should I look at next" verdict rather than raw agent state — the enum tells you which pane needs a reply, a commit, a review, or is safe to ignore. Most callers should just poll GET /api/overview(.txt) instead of calling this tool directly; call this only when you specifically need to trigger a fresh recommendation pass.
ASYNC: returns { jobId }. Then call job_wait({ jobId }) to block until it finishes and read the result, or job_status for a one-shot poll.
READ-ONLY: the worker reasons over a prompt only — no file reads, no shell, no repo tools. It never mutates anything.
OUTPUT: \`agents[]\`, each with \`recommendation\` (answer | continue | ship | review | merge | close | stale | watch), \`standing\` (one-line status), \`blocker\`, \`confidence\`. An id the model omitted is synthesized with \`recommendation: "watch"\`, \`confidence: "low"\`, \`synthesized: true\` — treat that as "no verdict", not a real judgment.
MODEL: ${describeRoute(routeFor("overview"))} — see GET /api/routing.`,
  });
}
