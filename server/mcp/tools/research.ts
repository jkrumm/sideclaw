import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESEARCH_INPUT } from "../../jobs/handlers/research.ts";
import { registerJobSubmitTool } from "./_job-tool.ts";

export function registerResearchTool(server: McpServer): void {
  registerJobSubmitTool(server, {
    name: "research",
    title: "Technical Research",
    tool: "research",
    inputSchema: RESEARCH_INPUT.shape,
    annotations: { readOnlyHint: true, idempotentHint: false },
    description: `Run a focused, cross-verified web research pass (Context7 + Tavily + readability-cli). Runs as a BACKGROUND JOB: returns a jobId immediately — it does NOT return the findings.

WHEN TO CALL: verifying a library API/version, evaluating an architecture choice, or any "is X still true / current best practice" question (post-training-cutoff).
ASYNC: returns { jobId }. Call job_wait({ jobId }) to block until done and read the result, or job_status to poll. The result has \`confidence\` (check first), \`summary\`, \`findings\`, \`recommendation\`, \`sources\`.
DEPTH: set \`depth\` from the user's ask — "quick research" → quick, "deep research" → deep, otherwise standard.
READ-ONLY: never modifies files.`,
  });
}
