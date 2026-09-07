import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appLogger as logger } from "../logger.ts";
import { buildOverviewPayload } from "./overview-payload.ts";

// Push the agent overview to Argo (the personal API + dashboard) so the fleet view exists
// somewhere other than this mini: after every completed `overview` job and every 10 minutes
// from a timer (both wired in server/index.ts). The body is exactly `GET /api/overview`'s
// `data` plus `machine` and `generatedAt` — one producer, no second shape to drift.
//
// Never fatal: Argo missing the route (404 until it deploys), a 5xx, a network error or an
// unresolvable secret all end in one `app.argo_push` log line with a `status` and nothing
// else. The push is telemetry, not a dependency.

const ARGO_URL = (process.env.ARGO_URL ?? "https://argo.jkrumm.com/api").replace(/\/+$/, "");
const MACHINE = "mini";
const PUSH_TIMEOUT_MS = 15_000;

// Same resolution as dispatch-git.ts's GitHub token: `secrets-run read <ref>` (the op shim
// against the mini's offline cache — a bare `op` would hang on a biometric prompt no one
// can answer), the value cached in memory for the process lifetime. A failed resolution is
// NOT cached: once the ref is sealed into the cache the next push picks it up without a
// reload. It IS remembered for the log: the first miss is a warn, every later one a debug
// line — a ref missing from the offline cache (until the next `make secrets-seed`) is one
// fact, not a 144-line/day warn stream from the 10-minute timer.
const SECRETS_RUN = join(homedir(), ".local", "bin", "secrets-run");
const ARGO_SECRET_REF = "op://common/api/SECRET";

let cachedSecret: string | undefined;
let secretMissWarned = false;

function logNoSecret(error: string, msg: string): void {
  const fields = { event: "app.argo_push", status: "no-secret", error };
  if (secretMissWarned) {
    logger.debug(fields, msg);
    return;
  }
  secretMissWarned = true;
  logger.warn(fields, `${msg} (further misses log at debug until it resolves)`);
}

async function argoSecret(): Promise<string | null> {
  if (cachedSecret) return cachedSecret;
  if (!existsSync(SECRETS_RUN)) return null;
  const proc = Bun.spawn([SECRETS_RUN, "read", ARGO_SECRET_REF], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const secret = stdout.trim();
    if (code === 0 && secret) {
      cachedSecret = secret;
      return secret;
    }
    logNoSecret(
      stderr.trim().slice(0, 200),
      `could not resolve ${ARGO_SECRET_REF} — argo push skipped`,
    );
    return null;
  } catch (err) {
    logNoSecret(String(err), "secrets-run failed — argo push skipped");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type ArgoPushStatus = "ok" | "no-secret" | "http-error" | "network-error" | "build-error";

/** One push. Resolves to the outcome, never rejects. `trigger` is only for the log line. */
export async function pushOverviewToArgo(trigger: "job" | "timer"): Promise<ArgoPushStatus> {
  const secret = await argoSecret();
  if (!secret) return "no-secret";

  let body: string;
  let agents = 0;
  try {
    const { payload } = await buildOverviewPayload();
    agents = payload.projects.reduce((n, p) => n + p.agents.length, 0);
    body = JSON.stringify({ ...payload, machine: MACHINE, generatedAt: payload.generatedAt });
  } catch (err) {
    logger.warn(
      { event: "app.argo_push", status: "build-error", trigger, error: String(err) },
      "overview payload could not be built — argo push skipped",
    );
    return "build-error";
  }

  const url = `${ARGO_URL}/agents/overview`;
  const startMs = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    const durationMs = Math.round(performance.now() - startMs);
    if (!res.ok) {
      logger.warn(
        {
          event: "app.argo_push",
          status: "http-error",
          httpStatus: res.status,
          trigger,
          durationMs,
        },
        `argo push rejected with ${res.status}`,
      );
      return "http-error";
    }
    logger.info(
      { event: "app.argo_push", status: "ok", httpStatus: res.status, trigger, agents, durationMs },
      "argo push ok",
    );
    return "ok";
  } catch (err) {
    logger.warn(
      { event: "app.argo_push", status: "network-error", trigger, error: String(err) },
      "argo push failed",
    );
    return "network-error";
  }
}
