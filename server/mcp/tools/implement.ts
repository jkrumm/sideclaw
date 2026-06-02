import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IMPLEMENT_INPUT } from "../../jobs/handlers/implement.ts";
import { registerJobSubmitTool } from "./_job-tool.ts";

export function registerImplementTool(server: McpServer): void {
  registerJobSubmitTool(server, {
    name: "implement",
    title: "Implement Coding Task",
    tool: "implement",
    inputSchema: IMPLEMENT_INPUT.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    description: `Delegate a scoped coding task to a bridge worker (DeepSeek-V4-Pro) that edits files with full permissions, self-verifies against the repo's checks, and reports back. Keeps heavy implementation off your Max subscription. Runs as a BACKGROUND JOB: returns a jobId immediately — it does NOT return the change report.

WHEN TO CALL: when you have planned a concrete, self-contained implementation task and want to offload the edits. Provide a precise task — the worker is a capable but literal executor, not a planner.
FAST PATH: pass \`validateCmd\` (the exact self-verify command, e.g. '.venv/bin/pyrefly check && .venv/bin/pytest -q') so the worker doesn't burn its turn budget — or hit the hard timeout — rediscovering the test runner. Critical on non-Node repos.
ASYNC: returns { jobId }. Call job_wait({ jobId }) to block until it finishes and read the result, or job_status to poll. The result has \`applied\`, \`checkPassed\`, \`filesChanged\`, \`notes\`. Review the diff yourself before committing.
SIDE EFFECTS: creates/edits files under \`cwd\` and runs the repo's validators. Does NOT commit, push, or branch.
CWD: absolute path of the target repo — not necessarily this session's CWD.`,
  });
}
