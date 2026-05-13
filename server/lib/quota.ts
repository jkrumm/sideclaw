import { logger } from "../mcp/logger.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

export type AuthMode = "max" | "iu" | "auto";
export type ResolvedAuthMode = "max" | "iu";

export interface ResolvedAuth {
  mode: ResolvedAuthMode;
  reason: string;
}

interface UsageBucket {
  utilization: number;
  resets_at_epoch?: number;
}

interface UsageCache {
  five_hour?: UsageBucket;
  seven_day?: UsageBucket;
  seven_day_sonnet?: UsageBucket;
  fetched_at?: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const USAGE_CACHE_PATH = "/tmp/claude_sl/usage_api.json";
const UTILIZATION_THRESHOLD = 70;
const CACHE_MAX_AGE_SEC = 10 * 60; // 10 minutes

// ── Helpers ────────────────────────────────────────────────────────────────────

async function readUsageCache(): Promise<UsageCache | null> {
  try {
    const file = Bun.file(USAGE_CACHE_PATH);
    if (!(await file.exists())) return null;
    return (await file.json()) as UsageCache;
  } catch (err) {
    logger.debug({ event: "quota.cache_read_fail", error: String(err) }, "usage cache read failed");
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Resolve a requested auth mode to a concrete mode (`max` | `iu`) with a
 * human-readable reason for logs.
 *
 * - `"max"` and `"iu"` are pass-through.
 * - `"auto"` reads `/tmp/claude_sl/usage_api.json`:
 *    - Missing or stale (>10 min) → fall back to `max` (safe default).
 *    - `max(five_hour.utilization, seven_day.utilization) >= 70` → `iu`.
 *    - Otherwise → `max`.
 */
export async function resolveAuthMode(requested: AuthMode): Promise<ResolvedAuth> {
  if (requested === "max") {
    return { mode: "max", reason: "explicit max" };
  }
  if (requested === "iu") {
    return { mode: "iu", reason: "explicit iu" };
  }

  const cache = await readUsageCache();
  if (!cache) {
    return { mode: "max", reason: "auto: usage cache missing — defaulting to max" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const fetchedAt = cache.fetched_at ?? 0;
  const ageSec = nowSec - fetchedAt;
  if (!fetchedAt || ageSec > CACHE_MAX_AGE_SEC) {
    return {
      mode: "max",
      reason: `auto: usage cache stale (age=${ageSec}s > ${CACHE_MAX_AGE_SEC}s) — defaulting to max`,
    };
  }

  const fiveHour = cache.five_hour?.utilization ?? 0;
  const sevenDay = cache.seven_day?.utilization ?? 0;
  const peak = Math.max(fiveHour, sevenDay);

  if (peak >= UTILIZATION_THRESHOLD) {
    return {
      mode: "iu",
      reason: `auto: peak utilization ${peak.toFixed(1)}% >= ${UTILIZATION_THRESHOLD}% (5h=${fiveHour.toFixed(1)}%, 7d=${sevenDay.toFixed(1)}%)`,
    };
  }

  return {
    mode: "max",
    reason: `auto: peak utilization ${peak.toFixed(1)}% < ${UTILIZATION_THRESHOLD}% (5h=${fiveHour.toFixed(1)}%, 7d=${sevenDay.toFixed(1)}%)`,
  };
}
