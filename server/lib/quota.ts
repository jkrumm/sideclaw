import { existsSync } from "node:fs";
import { logger } from "../mcp/logger.ts";

// ── Max subscription quota ────────────────────────────────────────────────────
//
// Reads the Claude Code Max subscription's rate-limit usage so
// `session-runner.ts` can fall a worker back onto the IU endpoint before Max
// quota is exhausted, rather than after it starts 429ing. Two sources, cheapest
// first:
//
// 1. The statusline's own cache (`/tmp/claude_sl/usage_api.json`, written by
//    dotfiles' `fetch_usage.py` every ~60s via LaunchAgent) — free, no network,
//    no keychain touch. Only trusted while fresh.
// 2. The live `api.anthropic.com/api/oauth/usage` endpoint, using the same
//    OAuth access token Claude Code itself keeps in the macOS Keychain. This is
//    the same recipe `fetch_usage.py` uses. Rate-limited per-token (429 within a
//    few requests/min), so results are cached in-memory for 60s and a failure
//    (429 or otherwise) falls back to the last good reading rather than going
//    straight to "unknown".
//
// Both sources fail soft: a stale file, a locked keychain, a 429 — none of them
// throw. The caller (`chooseBackend`) treats "unknown" as "don't block on missing
// data" and keeps the configured backend.

const QUOTA_FILE = "/tmp/claude_sl/usage_api.json";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const ANTHROPIC_BETA = "oauth-2025-04-20";

const QUOTA_FILE_MAX_AGE_S = Number(process.env.SIDECLAW_QUOTA_FILE_MAX_AGE_S ?? 600);

/** In-memory cache for the live API — the endpoint 429s per-token within a few
 *  requests/min, so every `readMaxQuota()` call across concurrent sessions must
 *  not each hit it. */
const API_CACHE_MS = 60_000;

export interface MaxQuota {
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  /** Epoch ms the five-hour window resets, or null if unknown. */
  fiveHourResetsAt: number | null;
  /** Epoch ms this reading was produced (file's own `fetched_at`, or now for the API path). */
  fetchedAt: number | null;
  source: "file" | "api" | "unknown";
}

const UNKNOWN_QUOTA: MaxQuota = {
  fiveHourPct: null,
  sevenDayPct: null,
  fiveHourResetsAt: null,
  fetchedAt: null,
  source: "unknown",
};

interface QuotaFileWindow {
  utilization?: number | null;
  resets_at_epoch?: number | null;
}

interface QuotaFileShape {
  five_hour?: QuotaFileWindow;
  seven_day?: QuotaFileWindow;
  fetched_at?: number;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/** Parse the statusline cache. Pure — no fs, no clock (both passed in) — so it
 *  is directly unit-testable against fresh/stale/malformed fixtures. Returns
 *  null on anything that isn't a fresh, well-shaped payload; the caller falls
 *  through to the live API on null. */
export function parseQuotaFile(json: unknown, nowMs: number, maxAgeS: number): MaxQuota | null {
  if (typeof json !== "object" || json === null) return null;
  const data = json as QuotaFileShape;
  if (typeof data.fetched_at !== "number") return null;
  const fetchedAtMs = data.fetched_at * 1000;
  if (nowMs - fetchedAtMs > maxAgeS * 1000) return null;
  return {
    fiveHourPct: numberOrNull(data.five_hour?.utilization),
    sevenDayPct: numberOrNull(data.seven_day?.utilization),
    fiveHourResetsAt:
      typeof data.five_hour?.resets_at_epoch === "number"
        ? data.five_hour.resets_at_epoch * 1000
        : null,
    fetchedAt: fetchedAtMs,
    source: "file",
  };
}

interface QuotaApiWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface QuotaApiShape {
  five_hour?: QuotaApiWindow;
  seven_day?: QuotaApiWindow;
}

function isoToEpochMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Parse the live `/api/oauth/usage` response (ISO `resets_at`, not epoch —
 *  different shape from the statusline file). Pure. */
export function parseQuotaApi(json: unknown): MaxQuota | null {
  if (typeof json !== "object" || json === null) return null;
  const data = json as QuotaApiShape;
  return {
    fiveHourPct: numberOrNull(data.five_hour?.utilization),
    sevenDayPct: numberOrNull(data.seven_day?.utilization),
    fiveHourResetsAt: isoToEpochMs(data.five_hour?.resets_at),
    fetchedAt: Date.now(),
    source: "api",
  };
}

async function keychainAccessToken(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    const parsed = JSON.parse(out.trim()) as { claudeAiOauth?: { accessToken?: string } };
    return parsed.claudeAiOauth?.accessToken ?? null;
  } catch {
    // Locked keychain (headless session) or a malformed blob — fail soft, never throw.
    return null;
  }
}

let lastGoodApi: MaxQuota | null = null;
let lastGoodApiAt = 0;

/** Live API path, with the 60s in-memory cache. Never throws — every failure
 *  (locked keychain, non-2xx, malformed body, network error) degrades to the
 *  last good reading, or `unknown` if there has never been one. */
async function fetchQuotaApi(): Promise<MaxQuota> {
  const now = Date.now();
  if (lastGoodApi && now - lastGoodApiAt < API_CACHE_MS) return lastGoodApi;

  const token = await keychainAccessToken();
  if (!token) return lastGoodApi ?? UNKNOWN_QUOTA;

  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": ANTHROPIC_BETA,
      },
    });
    if (!res.ok) return lastGoodApi ?? UNKNOWN_QUOTA;
    const json = await res.json();
    const parsed = parseQuotaApi(json);
    if (!parsed) return lastGoodApi ?? UNKNOWN_QUOTA;
    lastGoodApi = parsed;
    lastGoodApiAt = now;
    return parsed;
  } catch {
    return lastGoodApi ?? UNKNOWN_QUOTA;
  }
}

/** Current Max subscription quota, file-cache first, live API second. Never
 *  throws — a failure at every layer degrades to `source: "unknown"`, which
 *  `chooseBackend` treats as "never block on missing data". Logs only the
 *  source and the two percentages — never the token or the raw keychain blob. */
export async function readMaxQuota(): Promise<MaxQuota> {
  if (existsSync(QUOTA_FILE)) {
    try {
      const json = await Bun.file(QUOTA_FILE).json();
      const fromFile = parseQuotaFile(json, Date.now(), QUOTA_FILE_MAX_AGE_S);
      if (fromFile) {
        logger.info(
          {
            event: "quota.read",
            quotaSource: fromFile.source,
            fiveHourPct: fromFile.fiveHourPct,
            sevenDayPct: fromFile.sevenDayPct,
          },
          "quota read",
        );
        return fromFile;
      }
    } catch {
      // Malformed/unreadable file — fall through to the live API.
    }
  }

  const fromApi = await fetchQuotaApi();
  logger.info(
    {
      event: "quota.read",
      quotaSource: fromApi.source,
      fiveHourPct: fromApi.fiveHourPct,
      sevenDayPct: fromApi.sevenDayPct,
    },
    "quota read",
  );
  return fromApi;
}
