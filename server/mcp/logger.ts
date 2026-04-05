import { appendFileSync } from "fs";

export const LOG_FILE = "/tmp/sideclaw-mcp.log";

export function log(level: "info" | "error" | "debug", msg: string, data?: unknown): void {
  const ts = new Date().toISOString();
  const line = data !== undefined
    ? `${ts} [${level}] ${msg} ${JSON.stringify(data)}\n`
    : `${ts} [${level}] ${msg}\n`;
  console.error(line.trimEnd());
  try {
    appendFileSync(LOG_FILE, line);
  } catch { /* best-effort */ }
}
