// Which sideclaw entrypoint this OS process is: the always-on HTTP/job server
// (`server/index.ts`), or the stdio MCP process Claude Code spawns on demand
// (`server/mcp.ts`). Shared modules that both processes import — `session-runner.ts` is the
// concrete case — need this to tag their own logs with the right `source`, since a module-level
// `import { logger } from "./logger.ts"` bakes in "mcp" regardless of who actually runs it.
//
// A plain module-level `let` set by each entrypoint's OWN top-level code, not an env var:
// nothing here needs to survive a subprocess boundary, and this is simpler than threading an
// env flag through `Bun.spawn`'s env for two same-process entrypoints.
//
// Read this lazily (call `processKind()` at each log site, never capture it in a module-level
// constant computed at import time). ES import statements are hoisted and fully executed —
// recursively, depth-first — before ANY of the importing module's own top-level statements run.
// So `server/index.ts` writing `setProcessKind("app")` textually before its other imports does
// NOT make it run first: every one of those imports (including anything that transitively
// imports this module and `session-runner.ts`) finishes first. `setProcessKind` still runs
// early enough — before the HTTP server accepts a request or the MCP transport connects — so by
// the time any real session launches, the correct kind has always been set.
export type ProcessKind = "app" | "mcp";

// "mcp" preserves the historical behavior for any caller that never sets this — every
// runSession() caller was implicitly MCP-process-tagged before this module existed.
let kind: ProcessKind = "mcp";

export function setProcessKind(k: ProcessKind): void {
  kind = k;
}

export function processKind(): ProcessKind {
  return kind;
}
