import pino from "pino";
import { statSync, existsSync, renameSync, unlinkSync, createReadStream, createWriteStream } from "fs";
import { createInterface } from "readline";

export const LOG_FILE = "/tmp/sideclaw.jsonl";
const MB = 1024 * 1024;

export function createLogger(source: "app" | "mcp"): pino.Logger {
  const dest = pino.destination({ dest: LOG_FILE, sync: true, append: true });
  return pino(
    {
      timestamp: pino.stdTimeFunctions.isoTime,
      base: { pid: process.pid, source },
      serializers: { err: pino.stdSerializers.err },
      level: process.env.LOG_LEVEL ?? "debug",
      formatters: {
        level: (label) => ({ level: label }),
      },
    },
    dest,
  );
}

// Shared singleton for app (HTTP server + its modules). Import this instead of calling createLogger("app").
export const appLogger = createLogger("app");

export async function cleanupLogFile(): Promise<void> {
  if (!existsSync(LOG_FILE)) return;
  let size: number;
  try {
    size = statSync(LOG_FILE).size;
  } catch {
    return;
  }
  if (size < 100 * MB) return;

  // Phase 1: stream-filter debug lines older than 30 days
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const tmp = LOG_FILE + ".tmp";

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) {
        // Clean up tmp on error so a corrupt partial file is never left behind
        try { unlinkSync(tmp); } catch { /* best-effort */ }
        reject(err);
      } else {
        resolve();
      }
    };

    const rl = createInterface({ input: createReadStream(LOG_FILE), crlfDelay: Infinity });
    const out = createWriteStream(tmp, { flags: "w" });

    rl.on("line", (line) => {
      if (!line) return;
      let keep = true;
      try {
        const e = JSON.parse(line) as { level?: string; time?: string };
        if (e.level === "debug" && e.time) {
          const ts = new Date(e.time).getTime();
          if (!isNaN(ts) && ts < cutoff) keep = false;
        }
      } catch {
        // malformed line — keep
      }
      if (keep) out.write(line + "\n");
    });

    rl.on("close", () => out.end((err?: Error | null) => done(err ?? undefined)));
    rl.on("error", (err) => done(err));
    out.on("error", (err) => done(err));
  });

  // Phase 2: rename .tmp → log, then rotate if still oversized
  try {
    renameSync(tmp, LOG_FILE);
  } catch {
    // best-effort: leave original log intact if rename fails
    try { unlinkSync(tmp); } catch { /* ignore */ }
    return;
  }
  try {
    if (statSync(LOG_FILE).size > 200 * MB) renameSync(LOG_FILE, LOG_FILE + ".bak");
  } catch {
    // best-effort
  }
}
