import type { JobTool, JobView } from "../jobs/types.ts";

// Thin HTTP client used by the MCP tools to talk to the always-on HTTP server's
// job API (server/routes/jobs.ts). The MCP process is ephemeral (dies on /mcp
// disconnect); the HTTP server (LaunchAgent :7705) is durable and hosts the jobs.

const PORT = process.env.PORT ?? "7705";
const BASE = process.env.SIDECLAW_HTTP_URL ?? `http://localhost:${PORT}`;

/** Liveness probe so a down HTTP server produces a clear error, not an opaque fetch failure. */
export async function httpReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export const HTTP_DOWN_MESSAGE =
  `sideclaw HTTP server unreachable at ${BASE}. It hosts the job queue and runs via LaunchAgent — ` +
  `check 'tail -f /tmp/sideclaw.err' and run 'make reload' in ~/SourceRoot/sideclaw.`;

interface JobEnvelope {
  ok: boolean;
  job?: JobView;
  error?: string;
}

/** Submit a job. Returns the created job view (status usually "pending"/"running"). */
export async function submitJob(tool: JobTool, params: Record<string, unknown>): Promise<JobView> {
  const res = await fetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as JobEnvelope;
  if (!res.ok || !data.ok || !data.job) {
    throw new Error(data.error ?? `job submit failed with status ${res.status}`);
  }
  return data.job;
}

/** Fetch a job's current state. Returns null if the id is unknown (404). */
export async function getJobStatus(jobId: string): Promise<JobView | null> {
  const res = await fetch(`${BASE}/api/jobs/${encodeURIComponent(jobId)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  const data = (await res.json()) as JobEnvelope;
  if (!res.ok || !data.ok || !data.job) {
    throw new Error(data.error ?? `job status fetch failed with status ${res.status}`);
  }
  return data.job;
}
