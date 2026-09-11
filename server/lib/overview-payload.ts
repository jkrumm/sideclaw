import { buildSnapshot, type AgentsSnapshot } from "./agents.ts";
import { latestJobResult } from "../jobs/store.ts";
import {
  mergeOverviewIntoSnapshot,
  OVERVIEW_OUTPUT,
  type OverviewOutput,
} from "../jobs/handlers/overview.ts";
import {
  fetchWardenBoard,
  type FetchWardenBoardOptions,
  type WardenBoard,
} from "./warden-board.ts";
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

/** Same cache shape as `cachedBuildSnapshot`, own 45 s TTL — warden's board is folded into
 *  the overview payload only (never `/api/agents`), and happens to share `SNAPSHOT_CACHE_MS`'s
 *  window so a herdr pane polling both endpoints back-to-back never pays for two live warden
 *  round trips, but the two are independent constants: changing one must not silently change
 *  the other. Never rejects — `fetchWardenBoard` itself resolves failures to `{ ok: false }` —
 *  so there is no catch-and-drop needed here. */
const WARDEN_BOARD_CACHE_MS = 45_000;

let cachedWarden: { at: number; promise: Promise<WardenBoard> } | null = null;

/** `opts` (`fetchImpl`/`baseUrl`) is test-only — every real caller (`buildOverviewPayload`)
 *  omits it and gets the live loopback fetch, same convention as `fetchWardenBoard` itself. */
export function cachedFetchWardenBoard(opts?: FetchWardenBoardOptions): Promise<WardenBoard> {
  const now = Date.now();
  if (cachedWarden && now - cachedWarden.at < WARDEN_BOARD_CACHE_MS) return cachedWarden.promise;
  const promise = fetchWardenBoard(opts);
  cachedWarden = { at: now, promise };
  return promise;
}

/** Test-only — clears the in-memory warden board cache so each test starts from a cold
 *  cache rather than depending on run order. Mirrors `jobs/store.ts`'s `__resetForTests`. */
export function __resetWardenBoardCacheForTests(): void {
  cachedWarden = null;
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
  ReturnType<typeof mergeOverviewIntoSnapshot> & { warden: WardenBoard };

/** Fresh (cached ≤45 s) snapshot + the latest completed overview job, merged by agent id,
 *  plus warden's board fetched inside the same cache window. `payload` is exactly what
 *  `GET /api/overview` returns under `data`; `snapshot` and `merged` are the halves the text
 *  route needs separately. */
export async function buildOverviewPayload(): Promise<{
  snapshot: AgentsSnapshot;
  merged: ReturnType<typeof mergeOverviewIntoSnapshot>;
  warden: WardenBoard;
  payload: OverviewPayload;
}> {
  const [snapshot, warden] = await Promise.all([cachedBuildSnapshot(), cachedFetchWardenBoard()]);
  const cached = readCachedOverview();
  const merged = mergeOverviewIntoSnapshot(snapshot, cached);
  const payload = { ...snapshot, projects: merged.projects, overview: merged.overview, warden };
  return { snapshot, merged, warden, payload };
}
