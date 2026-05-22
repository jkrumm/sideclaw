import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { REVIEW_INPUT } from "../../jobs/handlers/review.ts";
import { registerJobSubmitTool } from "./_job-tool.ts";

export function registerReviewTool(server: McpServer): void {
  registerJobSubmitTool(server, {
    name: "review",
    title: "Code Review",
    tool: "review",
    inputSchema: REVIEW_INPUT.shape,
    annotations: { readOnlyHint: true, idempotentHint: false },
    description: `Run a deep multi-angle code review (architect + senior-dev always, file-type reviewers auto-added, plus a triage router for security/performance/concurrency/data-migration/api-contract). Runs as a BACKGROUND JOB: returns a jobId immediately — it does NOT return the findings.

WHEN TO CALL: before committing, before a PR, or when asked to review code quality.
ASYNC: returns { jobId }. Call job_wait({ jobId }) to block until done and read the result, or job_status to poll. The result has \`outcome\` (check first: "clean" | "actionable" | "needs-human"), \`blocking\`, \`improvements\`, \`discussions\`, \`testGaps\`.
READ-ONLY: never modifies files.
CWD: absolute path of the repo to review. SCOPE: "uncommitted" (default), "head", or a git ref/path.`,
  });
}
