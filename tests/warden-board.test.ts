// Bounds of server/lib/warden-board.ts: fetchWardenBoard normalizes warden's `GET /board`
// (docs/api.md in ~/SourceRoot/warden) into the shape server/lib/overview-payload.ts and
// server/lib/agents.ts's renderText consume, and never throws — an unreachable, non-2xx,
// timed-out or malformed warden degrades to `{ ok: false, error, fetchedAt }`.
//
// No real network — `fetchImpl` is injected per FetchWardenBoardOptions, same pattern as the
// rest of the repo stubbing an impure boundary rather than mocking global fetch.

import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { fetchWardenBoard } from "../server/lib/warden-board.ts";
import {
  __resetWardenBoardCacheForTests,
  cachedFetchWardenBoard,
} from "../server/lib/overview-payload.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rawItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 42,
    origin: "alert",
    repo: "warden",
    state: "needs_human",
    state_deadline: "2026-09-18T00:00:00+00:00",
    max_tier: "implement",
    title: "watchdog: sideclaw dispatch stuck",
    note: null,
    pr_url: null,
    dispatch_job: "j-abc",
    implement_job: null,
    validation_job: null,
    occurrences: 1,
    created_at: "2026-09-10T00:00:00+00:00",
    updated_at: "2026-09-11T00:00:00+00:00",
    ...overrides,
  };
}

function rawBoard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generated_at: "2026-09-11T00:00:00+00:00",
    schema_version: 8,
    counts: {
      new: 0,
      investigating: 1,
      verdict: 0,
      implementing: 0,
      validating: 0,
      merged: 0,
      liveness_pending: 0,
      needs_human: 2,
      merge_blocked: 0,
      split: 0,
    },
    items: [rawItem()],
    terminal_24h: 4,
    ...overrides,
  };
}

describe("fetchWardenBoard — ok", () => {
  test("normalizes a healthy /board response", async () => {
    const board = await fetchWardenBoard({
      fetchImpl: (async () => jsonResponse(rawBoard())) as typeof fetch,
    });
    expect(board.ok).toBe(true);
    if (!board.ok) throw new Error("unreachable");
    expect(board.generatedAt).toBe("2026-09-11T00:00:00+00:00");
    expect(board.counts.needs_human).toBe(2);
    expect(board.open).toBe(3); // 1 investigating + 2 needs_human
    expect(board.terminal24h).toBe(4);
    expect(board.itemsTruncated).toBe(false);
    expect(board.items).toHaveLength(1);
    expect(board.items[0]).toEqual({
      eventId: 42,
      origin: "alert",
      repo: "warden",
      state: "needs_human",
      title: "watchdog: sideclaw dispatch stuck",
      note: null,
      prUrl: null,
      updatedAt: "2026-09-11T00:00:00+00:00",
      inFlightJob: "j-abc", // dispatch_job — validation_job and implement_job are both null
    });
  });

  test("inFlightJob prefers validation_job, then implement_job, then dispatch_job", async () => {
    const board = await fetchWardenBoard({
      fetchImpl: (async () =>
        jsonResponse(
          rawBoard({
            items: [
              rawItem({
                event_id: 1,
                dispatch_job: "d-1",
                implement_job: "i-1",
                validation_job: "v-1",
              }),
              rawItem({ event_id: 2, dispatch_job: "d-2", implement_job: "i-2" }),
              rawItem({ event_id: 3, dispatch_job: "d-3" }),
            ],
          }),
        )) as typeof fetch,
    });
    if (!board.ok) throw new Error("unreachable");
    expect(board.items.map((i) => i.inFlightJob)).toEqual(["v-1", "i-2", "d-3"]);
  });

  test("caps items at 20 and sets itemsTruncated", async () => {
    const items = Array.from({ length: 25 }, (_, i) => rawItem({ event_id: i }));
    const board = await fetchWardenBoard({
      fetchImpl: (async () => jsonResponse(rawBoard({ items }))) as typeof fetch,
    });
    if (!board.ok) throw new Error("unreachable");
    expect(board.items).toHaveLength(20);
    expect(board.itemsTruncated).toBe(true);
    // Cap keeps warden's own updated_at DESC order — first 20, not last.
    expect(board.items[0]?.eventId).toBe(0);
  });

  test("exactly 20 items — itemsTruncated stays false unless warden itself said truncated", async () => {
    const items = Array.from({ length: 20 }, (_, i) => rawItem({ event_id: i }));
    const board = await fetchWardenBoard({
      fetchImpl: (async () => jsonResponse(rawBoard({ items }))) as typeof fetch,
    });
    if (!board.ok) throw new Error("unreachable");
    expect(board.items).toHaveLength(20);
    expect(board.itemsTruncated).toBe(false);
  });

  test("exactly 20 items with warden's own `truncated: true` — itemsTruncated is true", async () => {
    const items = Array.from({ length: 20 }, (_, i) => rawItem({ event_id: i }));
    const board = await fetchWardenBoard({
      fetchImpl: (async () => jsonResponse(rawBoard({ items, truncated: true }))) as typeof fetch,
    });
    if (!board.ok) throw new Error("unreachable");
    expect(board.items).toHaveLength(20);
    expect(board.itemsTruncated).toBe(true);
  });

  test("0 items — empty board, itemsTruncated false", async () => {
    const board = await fetchWardenBoard({
      fetchImpl: (async () => jsonResponse(rawBoard({ items: [] }))) as typeof fetch,
    });
    if (!board.ok) throw new Error("unreachable");
    expect(board.items).toHaveLength(0);
    expect(board.itemsTruncated).toBe(false);
  });
});

describe("fetchWardenBoard — failure modes", () => {
  test("a non-2xx status resolves to ok:false with the status in the error", async () => {
    const board = await fetchWardenBoard({
      fetchImpl: (async () => jsonResponse({ error: "schema mismatch" }, 503)) as typeof fetch,
    });
    expect(board.ok).toBe(false);
    if (board.ok) throw new Error("unreachable");
    expect(board.error).toContain("503");
  });

  test("a network/timeout error (rejected fetch) resolves to ok:false, never throws", async () => {
    const board = await fetchWardenBoard({
      fetchImpl: (async () => {
        throw new Error("The operation was aborted");
      }) as typeof fetch,
    });
    expect(board.ok).toBe(false);
    if (board.ok) throw new Error("unreachable");
    expect(board.error).toContain("aborted");
  });

  test("malformed JSON resolves to ok:false, never throws", async () => {
    const board = await fetchWardenBoard({
      fetchImpl: (async () => new Response("not json", { status: 200 })) as typeof fetch,
    });
    expect(board.ok).toBe(false);
    if (board.ok) throw new Error("unreachable");
    expect(board.error).toBeTruthy();
  });

  test("a response that parses but fails schema validation resolves to ok:false", async () => {
    const board = await fetchWardenBoard({
      fetchImpl: (async () => jsonResponse({ nonsense: true })) as typeof fetch,
    });
    expect(board.ok).toBe(false);
    if (board.ok) throw new Error("unreachable");
    expect(board.error).toContain("schema validation");
  });
});

// ── cachedFetchWardenBoard (server/lib/overview-payload.ts) — the 45 s TTL ──────────────────

describe("cachedFetchWardenBoard", () => {
  afterAll(() => setSystemTime());

  test("reuses the same promise for calls within the TTL", async () => {
    __resetWardenBoardCacheForTests();
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(rawBoard());
    }) as typeof fetch;

    const first = await cachedFetchWardenBoard({ fetchImpl });
    setSystemTime(new Date("2026-01-01T00:00:44Z")); // 44s later — still within 45s TTL
    const second = await cachedFetchWardenBoard({ fetchImpl });

    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  test("refetches once the TTL has elapsed", async () => {
    __resetWardenBoardCacheForTests();
    setSystemTime(new Date("2026-01-02T00:00:00Z"));
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(rawBoard());
    }) as typeof fetch;

    await cachedFetchWardenBoard({ fetchImpl });
    setSystemTime(new Date("2026-01-02T00:00:46Z")); // 46s later — past the 45s TTL
    await cachedFetchWardenBoard({ fetchImpl });

    expect(calls).toBe(2);
  });
});
