import type { Octokit } from "@octokit/rest";
import { appLogger as logger } from "../logger.ts";

// ETag + soft-TTL cache for Octokit, installed as request hooks.
//
// Two layers of savings:
//
// 1. Soft-TTL fan-out cache — if a GET was made within `softTtlMs`, return
//    the stored payload without hitting GitHub. Absorbs polling stampedes
//    across tabs / panels / SSE-triggered refreshes for the same repo.
//
// 2. ETag revalidation — once soft-TTL expires, send `If-None-Match`. GitHub
//    returns 304 Not Modified, which does NOT count against the primary
//    5,000/hr rate limit. We catch the 304 in `hook.error` and return the
//    cached payload.

type CacheEntry = {
  etag: string;
  status: number;
  headers: Record<string, string>;
  data: unknown;
  url: string;
  fetchedAt: number;
};

type OctokitResponse = {
  status: number;
  url: string;
  headers: Record<string, string>;
  data: unknown;
};

const SOFT_HIT_SENTINEL = Symbol("github-cache.soft-hit");

interface SoftHitError extends Error {
  [SOFT_HIT_SENTINEL]: CacheEntry;
}

function isSoftHit(err: unknown): err is SoftHitError {
  return typeof err === "object" && err !== null && SOFT_HIT_SENTINEL in err;
}

const keyOf = (method: string, url: string) => `${method} ${url}`;

// Per-endpoint soft TTL. Repo file contents (e.g. release.yml existence)
// rarely change — caching for 5 min is fine. Everything else: 10s.
function getSoftTtlMs(url: string): number {
  if (url.includes("/contents/")) return 5 * 60_000;
  return 10_000;
}

const DEFAULT_MAX_ENTRIES = 500;

export interface EtagCacheOptions {
  maxEntries?: number;
}

export function installEtagCache(octokit: Octokit, opts: EtagCacheOptions = {}): void {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const cache = new Map<string, CacheEntry>();

  const touch = (key: string, entry: CacheEntry) => {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  // Resolve the route template + parameters into the concrete URL Octokit
  // will actually fetch, so cache keys distinguish e.g. owner=a vs owner=b.
  // Falls back to the raw options url+method if endpoint() can't parse them
  // (defensive — shouldn't happen for normal Octokit calls).
  const resolveRequest = (options: Parameters<typeof octokit.request.endpoint>[0]) => {
    try {
      const resolved = octokit.request.endpoint(options);
      return { method: resolved.method.toUpperCase(), url: resolved.url };
    } catch {
      const fallbackMethod =
        typeof (options as { method?: unknown }).method === "string"
          ? ((options as { method: string }).method ?? "GET").toUpperCase()
          : "GET";
      const fallbackUrl =
        typeof (options as { url?: unknown }).url === "string"
          ? (options as { url: string }).url
          : "";
      return { method: fallbackMethod, url: fallbackUrl };
    }
  };

  octokit.hook.before("request", (options) => {
    const { method, url } = resolveRequest(options);
    if (method !== "GET") return;
    const key = keyOf(method, url);
    const entry = cache.get(key);
    if (!entry) return;

    // Soft-TTL hit: short-circuit before touching GitHub by throwing a
    // sentinel that hook.error converts back into a normal response.
    if (Date.now() - entry.fetchedAt < getSoftTtlMs(url)) {
      const err = new Error("github-cache soft hit") as SoftHitError;
      Object.defineProperty(err, SOFT_HIT_SENTINEL, { value: entry, enumerable: false });
      throw err;
    }

    // Stale: revalidate. GitHub etag values already include surrounding
    // double quotes — store and re-inject verbatim.
    options.headers = { ...options.headers, "if-none-match": entry.etag };
  });

  octokit.hook.after("request", (response, options) => {
    const { method, url } = resolveRequest(options);
    if (method !== "GET") return;
    const etag = response.headers?.etag;
    if (!etag) return;
    const key = keyOf(method, url);
    touch(key, {
      etag,
      status: response.status,
      headers: response.headers ?? {},
      data: response.data,
      url: response.url ?? url,
      fetchedAt: Date.now(),
    });
    logger.debug(
      { event: "github.cache.miss", url, status: response.status },
      "github cache miss (full response)",
    );
  });

  octokit.hook.error("request", (error, options) => {
    if (isSoftHit(error)) {
      const entry = error[SOFT_HIT_SENTINEL];
      logger.debug(
        { event: "github.cache.hit", url: entry.url, kind: "soft" },
        "github cache soft-ttl hit",
      );
      return {
        status: 200,
        url: entry.url,
        headers: entry.headers,
        data: entry.data,
      } satisfies OctokitResponse;
    }

    const status = (error as { status?: number }).status;
    if (status === 304) {
      const { method, url } = resolveRequest(options);
      const key = keyOf(method, url);
      const entry = cache.get(key);
      if (entry) {
        entry.fetchedAt = Date.now();
        logger.debug(
          { event: "github.cache.hit", url, kind: "304" },
          "github cache 304 revalidate",
        );
        return {
          status: 200,
          url: entry.url,
          headers: entry.headers,
          data: entry.data,
        } satisfies OctokitResponse;
      }
    }

    throw error;
  });
}
