import { buildSnapshot, type AgentsSnapshot } from "./agents.ts";
import { latestJobResult } from "../jobs/store.ts";
import {
  mergeOverviewIntoSnapshot,
  OVERVIEW_OUTPUT,
  type OverviewOutput,
} from "../jobs/handlers/overview.ts";
import { appLogger as logger } from "../logger.ts";

// The one JSON `GET /api/overview` returns — a fresh deterministic snapshot with the newest
// completed `overview` job merged onto it by agent id. Shared by the HTTP routes
// (server/routes/agents.ts) and the Argo push (server/lib/argo-push.ts) so the two never
// disagree about what "the overview" is.

/** Snapshot cache: the herdr pane (`watch -n 30`), Hermes and the Argo push all read the
 *  same thing within seconds of each other, and one snapshot costs three CLI calls plus a
 *  transcript tail per agent plus a git status per project. Measured over 4 days, consumers'
 *  real poll interval is ~31 s, not 30 — 20 s missed the cache window on nearly every request
 *  (2652/2720 `/api/overview.txt` and 2805/2826 `/api/agents.txt` calls took >500 ms, ~5500
 *  full rebuilds at p50 1.5 s). 45 s clears that gap and still stays under the 10-minute Argo
 *  push timer. The promise (not the value) is cached so concurrent first callers share one
 *  build instead of racing. */
const SNAPSHOT_CACHE_MS = 45_000;

let cachedSnapshot: { at: number; promise: Promise<AgentsSnapshot> } | null = null;

export function cachedBuildSnapshot(): Promise<AgentsSnapshot> {
  const now = Date.now();
  if (cachedSnapshot && now - cachedSnapshot.at < SNAPSHOT_CACHE_MS) return cachedSnapshot.promise;
  const promise = buildSnapshot();
  cachedSnapshot = { at: now, promise };
  // A failed build must not be served for 20 s — drop it so the next caller rebuilds.
  promise.catch(() => {
    if (cachedSnapshot?.promise === promise) cachedSnapshot = null;
  });
  return promise;
}

/** Reads the latest completed `overview` job result, re-validated against its own output
 *  schema (the row is untyped JSON from sqlite) — a schema drift between an old cached job
 *  and the current OVERVIEW_OUTPUT shape degrades to "no cached overview" rather than a
 *  500. */
function readCachedOverview(): OverviewOutput | null {
  const cached = latestJobResult("overview");
  if (!cached) return null;
  const parsed = OVERVIEW_OUTPUT.safeParse(cached.result);
  if (!parsed.success) {
    logger.warn(
      { event: "overview.cache_parse_failed", tool: "overview", error: parsed.error.message },
      "cached overview job result failed schema validation — treating as absent",
    );
    return null;
  }
  return parsed.data;
}

export type OverviewPayload = Omit<AgentsSnapshot, "projects"> &
  ReturnType<typeof mergeOverviewIntoSnapshot>;

/** Fresh (cached ≤20 s) snapshot + the latest completed overview job, merged by agent id.
 *  `payload` is exactly what `GET /api/overview` returns under `data`; `snapshot` and
 *  `merged` are the halves the text route needs separately. */
export async function buildOverviewPayload(): Promise<{
  snapshot: AgentsSnapshot;
  merged: ReturnType<typeof mergeOverviewIntoSnapshot>;
  payload: OverviewPayload;
}> {
  const snapshot = await cachedBuildSnapshot();
  const cached = readCachedOverview();
  const merged = mergeOverviewIntoSnapshot(snapshot, cached);
  const payload = { ...snapshot, projects: merged.projects, overview: merged.overview };
  return { snapshot, merged, payload };
}
