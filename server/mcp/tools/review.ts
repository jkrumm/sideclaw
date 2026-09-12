import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { REVIEW_INPUT } from "../../jobs/handlers/review.ts";
import { registerJobSubmitTool } from "./_job-tool.ts";
import { describeRoute, routeFor } from "../../lib/routing.ts";

// Omit `model` from the MCP-facing schema: it exists on REVIEW_INPUT for a caller posting
// straight to POST /api/jobs (warden's step-7 review-validation knob), not for an interactive
// /review call, which has no reason to re-route off the measured-good default and would
// otherwise silently drop the Max fallback if it did (see the field's own `.describe()`). The
// handler still validates the full REVIEW_INPUT either way, so this only narrows what an MCP
// client is offered, not what the job endpoint accepts. Exported so tests can assert the
// narrowing directly rather than re-deriving it.
export const REVIEW_MCP_INPUT = REVIEW_INPUT.omit({ model: true });

export function registerReviewTool(server: McpServer): void {
  registerJobSubmitTool(server, {
    name: "review",
    title: "Code Review",
    tool: "review",
    inputSchema: REVIEW_MCP_INPUT.shape,
    annotations: { readOnlyHint: true, idempotentHint: false },
    description: `Run a deep multi-angle code review (architect + senior-dev always, file-type reviewers auto-added, plus a triage router for security/performance/concurrency/data-migration/api-contract/resilience). Runs as a BACKGROUND JOB: returns a jobId immediately — it does NOT return the findings.

WHEN TO CALL: before committing, before a PR, or when asked to review code quality.
ASYNC: returns { jobId }. Call job_wait({ jobId }) to block until done and read the result, or job_status to poll. The result has \`outcome\` (check first: "clean" | "actionable" | "needs-human"), \`blocking\`, \`improvements\`, \`discussions\`, \`testGaps\`, \`schemaVersion\` (see GET /api/review-schema).
READ-ONLY: never modifies files.
CWD: absolute path of the repo to review. SCOPE: "uncommitted" (default) = working changes; "head" = last commit; a ref like "HEAD~3"/SHA = the range up to HEAD (last N commits); an explicit range like "main..HEAD" or a file path.
PR/BRANCH: pass \`pr\` (a pull request number) or \`branch\` (a remote branch name on \`cwd\`'s origin) instead of \`scope\` to review a ref that has no local checkout — e.g. the branch an \`implement\` dispatch episode pushed after its own worktree was torn down. Runs in a throwaway read-only worktree fetched from origin; \`scope\` must be omitted with either.
MODEL: angles + synthesis ${describeRoute(routeFor("review"))}; adversary ${describeRoute(routeFor("adversary"))} — see GET /api/routing.`,
  });
}
