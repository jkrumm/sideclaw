// Shared idle-watchdog budget: no activity (a subprocess stdout chunk, an SSE token) for this
// long means "wedged", not "slow" — see server/mcp/session-runner.ts for the full agentic-
// worker rationale (no turn limit, no wall-clock ceiling, idle-only). Extracted into its own
// module, rather than importing it from session-runner.ts directly, because session-runner.ts
// itself imports server/lib/iu-openai.ts (`getIuConfig`) — a reverse import would be circular.
// This file is the one number both sides reuse.
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
