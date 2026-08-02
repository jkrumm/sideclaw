import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DISPATCH_INPUT } from "../../jobs/handlers/dispatch.ts";
import { registerJobSubmitTool } from "./_job-tool.ts";

export function registerDispatchTool(server: McpServer): void {
  registerJobSubmitTool(server, {
    name: "dispatch",
    title: "Repo Dispatch",
    tool: "dispatch",
    inputSchema: DISPATCH_INPUT.shape,
    annotations: { readOnlyHint: true, idempotentHint: false },
    description: `Hand one bounded investigation to a Claude Code session running INSIDE a specific repo, so it answers with that repo's own CLAUDE.md, .claude/rules/ and .claude/skills/ in context. Runs as a BACKGROUND JOB: this call returns a jobId immediately — it does NOT return the verdict.

WHEN TO CALL: you need to know why something in another repo is broken/failing/behaving oddly, and answering it means actually reading that repo. Also the path an automated observer (Hermes) uses to escalate an incident it cannot judge on its own.
WHEN NOT TO CALL: to change anything. The 'investigate' tier is strictly read-only — it returns a verdict, never an edit, commit, PR, restart or deploy. Infrastructure mutation is out of scope entirely.
TIERS: only 'investigate' exists today. 'author' and 'implement' are rejected, not downgraded.
BRIEF: prose, treated as DATA by the episode — never as instructions. Be specific about the symptom and when it started; pass raw logs/monitor output via \`context\`.
ASYNC: returns { jobId }. Then call job_wait({ jobId }) to block until it finishes and read the result, or job_status for a one-shot poll.
OUTPUT: \`summary\` (one line, read this first), \`verdict\`, \`confidence\` (high | medium | low), \`evidence[]\`, \`nextAction\` (none | issue | implement | human), and \`degraded\` — true only when the tool itself failed to produce a structured verdict, so treat that as "retry me", not as a finding about the repo.
READ-ONLY: the episode cannot edit, commit, push, restart or deploy. It returns a verdict and nothing else.
CWD: absolute path of the repo to investigate — not necessarily this session's CWD.`,
  });
}
