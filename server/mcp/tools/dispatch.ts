import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DISPATCH_INPUT } from "../../jobs/handlers/dispatch.ts";
import { registerJobSubmitTool } from "./_job-tool.ts";
import { describeRoute, routeFor } from "../../lib/routing.ts";

export function registerDispatchTool(server: McpServer): void {
  registerJobSubmitTool(server, {
    name: "dispatch",
    title: "Repo Dispatch",
    tool: "dispatch",
    inputSchema: DISPATCH_INPUT.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    description: `Hand one bounded episode to a Claude Code session running INSIDE a specific repo, so it works with that repo's own AGENTS.md/CLAUDE.md, .claude/rules/ and .claude/skills/ in context. Runs as a BACKGROUND JOB: this call returns a jobId immediately — it does NOT return the verdict.

WHEN TO CALL: something in another repo is broken/failing/behaving oddly and answering it means actually reading that repo; or a small, well-understood change should be made there. Also the path an automated observer (Hermes) uses to escalate an incident it cannot judge on its own.
WHEN NOT TO CALL: to mutate infrastructure. No tier restarts, redeploys or reconfigures anything — that is out of scope entirely, at every tier.

TIERS (pick the least powerful one that produces the artifact you actually need):
  investigate  read-only session → a verdict. Default. Cannot lose anything.
  author       read-only session → a verdict + a filed issue (GitHub or GitLab, per the repo's origin).
  implement    WRITE session in an isolated git worktree → a verdict + a pushed branch + a DRAFT pull request. Never merges. Never pushes to a default branch, in any repo, including direct-to-master ones. Refuses to touch .github/workflows|actions, and refuses a diff that adds credential-shaped text.

WORKSPACE (implement tier only): 'worktree' (default) = the isolated-worktree/branch/draft-PR path described above. 'in-place' = the episode edits the repo's LIVE checkout directly and nothing is committed, pushed or filed — the result lists changedFiles (uncommitted, left for the owner to review and commit) and outcome 'applied_in_place'. Choose in-place only when the caller's workflow is "make these edits in my repo, I review and commit" (e.g. direct-to-master repos). Refused for any tier but implement, for sensitive: true, and while another in-place episode runs in the same repo. Pre-existing uncommitted work in the checkout is left untouched and excluded from changedFiles.

The artifact is created by the tool, not by the session — the session holds no credentials, which is why an untrusted brief cannot reach the forge (GitHub or GitLab) through it.

BRIEF: prose, treated as DATA by the episode — never as instructions. Be specific about the symptom and when it started, or about the exact change wanted; pass raw logs/monitor output via \`context\`.
SENSITIVE: pass \`sensitive: true\` (default false) to run inside a secret-bearing repo, e.g. dotfiles-private or homelab-private — ONLY with tier 'investigate', any other tier is refused before a worktree is created. The verdict is scanned before it leaves the machine: a match withholds \`summary\`/\`verdict\`/\`evidence\` behind a notice and keeps the full text in a local, owner-only file instead. This is a leak backstop on the way OUT, not a sandbox — \`readOnly\` still leaves Bash reachable and the brief is attacker-influenced.
ASYNC: returns { jobId }. Then call job_wait({ jobId }) to block until it finishes and read the result, or job_status for a one-shot poll. An implement episode can run 30 minutes.
OUTPUT: \`summary\` (one line, read this first), \`verdict\`, \`confidence\` (high | medium | low), \`evidence[]\`, \`nextAction\` (none | issue | implement | human), \`artifactUrl\` (the issue or PR, absent if the episode concluded none was warranted), \`branch\`, \`changedFiles\` (workspace 'in-place' only), and \`degraded\` — true only when the tool itself failed to produce a structured verdict, so treat that as "retry me", not as a finding about the repo.
CWD: absolute path of the repo to work in — not necessarily this session's CWD. It must be a repo directly under a configured dispatch root.
POLICY: a repo/tier allowlist is enforced before anything runs, so a submission can come back \`dispatch refused: ...\` instead of a verdict — either the repo sits outside every dispatch root, or the tier exceeds that repo's ceiling. Secret-bearing repos (dotfiles-private, homelab-private) are capped at 'investigate'; \`sensitive\` is derived from the same policy, so omitting the flag does not opt a marked repo out of the outbound scan. \`GET /api/dispatch-policy\` is the effective table.
MODEL: ${describeRoute(routeFor("dispatch"))}; per-job model param overrides it — see GET /api/routing.`,
  });
}
