import { existsSync } from "fs";

import type { SessionResult } from "../mcp/session-runner.ts";

/** Shared plumbing every worker-backed job repeats around a `runSession()` call: read the
 *  skill prompt, unwrap the result, and — for the cheap tiers — re-ask for JSON once. Kept in
 *  one module because the handlers that need one of these almost always need all three; the
 *  prompt-injection fence is deliberately NOT here (`prompt-fence.ts`), since that one is a
 *  security boundary and deserves to be read on its own. */

// Shared `existsSync` → throw → read pattern behind every job/tool's skill-prompt loader.
// `.text()`, never `.toString()` — a `Bun.file(...).toString()` returns the literal string
// `"[object Blob]"` (see .claude/rules/mcp-tools.md), which would silently ship as the prompt.

/** Read a skill-prompt file, throwing with the concrete path if it's missing. `label` names
 *  the caller in the error (e.g. "check", "dispatch") so a renamed/misplaced skill file fails
 *  with a message that says which tool broke, not just that some file is gone. */
export async function loadSkillFile(path: string, label: string): Promise<string> {
  if (!existsSync(path)) {
    throw new Error(`${label} skill prompt not found at ${path}`);
  }
  return Bun.file(path).text();
}

/** Unwrap a worker `SessionResult`, throwing `result.error` (or a `"${label} produced no
 *  result"` fallback) when the session failed or came back empty. Returns the narrowed `data`
 *  on success so callers never need a non-null assertion afterward. */
export function unwrap<T>(result: SessionResult<T>, label: string): T {
  if (!result.ok || !result.data) {
    throw new Error(result.error ?? `${label} produced no result`);
  }
  return result.data;
}

// Shared one-shot salvage suffix for `check`/`narrative`: the cheap tier occasionally answers
// the output contract in prose ("All 3 steps passed!") with no structured_output, which
// surfaces as `noOutput`. Appending this and retrying once tells the worker to answer with
// ONLY the JSON object. NOT shared with dispatch's own `JSON_ONLY_RETRY` — that wording is
// deliberately different (see dispatch.ts's comment on why a "just serialize it" instruction
// would be a lie there) and must stay untouched.
export const JSON_ONLY_RETRY = `

────────────────────────────────────────────────────────
RETRY — your previous response was REJECTED because it was not valid JSON matching the schema.
Return ONLY the JSON object specified above. Your entire message must be a single JSON object
(optionally wrapped in one \`\`\`json fence) — no preamble, no markdown headings, no commentary
before or after. Emit it as your final message and stop.`;
