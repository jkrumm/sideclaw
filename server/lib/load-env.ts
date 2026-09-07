import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Bun auto-loads `.env` from the process CWD only. The HTTP server starts in the repo root
// (LaunchAgent WorkingDirectory) and gets it for free; the MCP process is spawned by the
// calling Claude Code session with THAT session's cwd, so it never saw sideclaw/.env —
// which is why `otel` (and the MCP-side routing/backend flags) silently ran without
// SIDECLAW_* / RESEARCH_GATEWAY_* for months. Import this module FIRST in mcp.ts: ES
// imports evaluate in order, and session-runner/routing read their flags at load.
//
// Existing environment always wins — a value the caller exported deliberately is not
// overridden by the file. Parser covers the shape the file actually has: `KEY=value`,
// optional single/double quotes, `#` comments, blank lines. Nothing fancier on purpose.

const ENV_FILE = join(import.meta.dir, "..", "..", ".env");

/** Pure: `.env` text → key/value pairs. Exported for tests. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[key] = value;
  }
  return out;
}

export function loadRepoEnv(): number {
  if (!existsSync(ENV_FILE)) return 0;
  let applied = 0;
  for (const [key, value] of Object.entries(parseDotEnv(readFileSync(ENV_FILE, "utf-8")))) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    applied++;
  }
  return applied;
}

loadRepoEnv();
