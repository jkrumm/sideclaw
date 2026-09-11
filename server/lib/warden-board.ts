import { z } from "zod";
import { appLogger as logger } from "../logger.ts";
import {
  RESET,
  BOLD,
  BOLD_RED,
  GREEN,
  MIN_TITLE_CHARS,
  clampLine,
  clampVisible,
  relativeAge,
  stripControlBytes,
  truncate,
} from "./render-text-utils.ts";

// One producer for warden's `GET /board` snapshot, consumed by
// server/lib/overview-payload.ts (folded into the same 45 s cache window as the agents
// snapshot) and rendered by server/lib/agents.ts's `renderText`. warden is the control plane
// on this box — a loopback-only, unauthenticated, read-only HTTP API at
// `http://127.0.0.1:7734` (`~/SourceRoot/warden`, docs/api.md's `### GET /board`). Never
// throws: an unreachable/misconfigured/schema-mismatched warden degrades to `{ ok: false }`,
// never a 500 or a delayed overview.

const WARDEN_BOARD_TIMEOUT_MS = 2_000;
const WARDEN_ITEMS_CAP = 20;

// warden's own `counts` always carries the ten non-terminal chain states with a guaranteed
// zero, but any *other* non-terminal state present in the ledger (e.g. a future `snoozed`)
// still appears without one — an index signature keeps an unrecognized key readable instead
// of dropped.
export interface WardenCounts {
  new: number;
  investigating: number;
  verdict: number;
  implementing: number;
  validating: number;
  merged: number;
  liveness_pending: number;
  needs_human: number;
  merge_blocked: number;
  split: number;
  [state: string]: number;
}

export interface WardenItem {
  eventId: string | number;
  origin: string;
  repo: string;
  state: string;
  title: string;
  note: string | null;
  prUrl: string | null;
  updatedAt: string;
  /** `validation_job ?? implement_job ?? dispatch_job ?? null` — the one job id, if any, an
   *  observer would poll to see this item's current in-flight work. */
  inFlightJob: string | null;
}

export type WardenBoard =
  | {
      ok: true;
      generatedAt: string;
      counts: WardenCounts;
      /** Sum of every `counts` value — every entry there is a non-terminal (open) chain
       *  state, so this is the total item count without re-deriving terminality here. */
      open: number;
      items: WardenItem[];
      /** True only when warden's own `items` exceeded our 20-item cap — omitted-vs-false is
       *  not meaningful here, always present on the ok branch. */
      itemsTruncated: boolean;
      terminal24h: number;
      fetchedAt: number;
    }
  | { ok: false; error: string; fetchedAt: number };

// The ten chain states warden's own `counts` always carries with a guaranteed zero (see
// `WardenCounts`'s doc comment) — required as numbers so a missing/renamed key fails schema
// validation loudly instead of silently degrading every consumer to a `?? 0` guess.
// `.passthrough()` keeps any *other* non-terminal state (e.g. a future `snoozed`) readable
// rather than dropped.
const WARDEN_COUNTS_RAW = z
  .object({
    new: z.number(),
    investigating: z.number(),
    verdict: z.number(),
    implementing: z.number(),
    validating: z.number(),
    merged: z.number(),
    liveness_pending: z.number(),
    needs_human: z.number(),
    merge_blocked: z.number(),
    split: z.number(),
  })
  .passthrough();

const WARDEN_ITEM_RAW = z.object({
  event_id: z.union([z.string(), z.number()]),
  origin: z.string(),
  repo: z.string(),
  state: z.string(),
  title: z.string(),
  note: z.string().nullable().optional(),
  pr_url: z.string().nullable().optional(),
  dispatch_job: z.string().nullable().optional(),
  implement_job: z.string().nullable().optional(),
  validation_job: z.string().nullable().optional(),
  updated_at: z.string(),
});

const WARDEN_BOARD_RAW = z.object({
  generated_at: z.string(),
  counts: WARDEN_COUNTS_RAW,
  items: z.array(WARDEN_ITEM_RAW),
  terminal_24h: z.number(),
  truncated: z.boolean().optional(),
});

/** One `logger.warn` per `ok: false` branch below, so an unreachable/misconfigured warden
 *  shows up in the log stream even though the failure never surfaces as an error to a
 *  caller (every branch degrades silently to `{ ok: false }` — see the module comment). */
function unavailable(error: string, fetchedAt: number): WardenBoard {
  logger.warn({ event: "warden.board_unavailable", error }, "warden board unavailable");
  return { ok: false, error, fetchedAt };
}

function toWardenItem(raw: z.infer<typeof WARDEN_ITEM_RAW>): WardenItem {
  return {
    eventId: raw.event_id,
    origin: raw.origin,
    repo: raw.repo,
    state: raw.state,
    title: raw.title,
    note: raw.note ?? null,
    prUrl: raw.pr_url ?? null,
    updatedAt: raw.updated_at,
    inFlightJob: raw.validation_job ?? raw.implement_job ?? raw.dispatch_job ?? null,
  };
}

export interface FetchWardenBoardOptions {
  /** Override for tests — a stubbed `fetch`-shaped function. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override for tests. Defaults to `WARDEN_API_URL` env, then the loopback default. */
  baseUrl?: string;
}

/** Fetches and normalizes warden's `GET /board`. Never throws — any failure (network, non-2xx,
 *  timeout, malformed JSON/schema) resolves to `{ ok: false, error, fetchedAt }` so a warden
 *  outage never delays or fails the overview it's folded into. `items` is already
 *  `updated_at DESC` from warden, so capping to the first `WARDEN_ITEMS_CAP` keeps that order. */
export async function fetchWardenBoard(opts?: FetchWardenBoardOptions): Promise<WardenBoard> {
  const fetchedAt = Date.now();
  const baseUrl = (opts?.baseUrl ?? process.env.WARDEN_API_URL ?? "http://127.0.0.1:7734").replace(
    /\/+$/,
    "",
  );
  const doFetch = opts?.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`${baseUrl}/board`, {
      signal: AbortSignal.timeout(WARDEN_BOARD_TIMEOUT_MS),
    });
  } catch (err) {
    return unavailable(String(err), fetchedAt);
  }

  if (!res.ok) {
    return unavailable(`warden /board returned ${res.status}`, fetchedAt);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    return unavailable(`warden /board returned invalid JSON: ${String(err)}`, fetchedAt);
  }

  const parsed = WARDEN_BOARD_RAW.safeParse(json);
  if (!parsed.success) {
    return unavailable(
      `warden /board failed schema validation: ${parsed.error.message}`,
      fetchedAt,
    );
  }

  const items = parsed.data.items.map(toWardenItem);
  const open = Object.values(parsed.data.counts).reduce((sum, n) => sum + n, 0);

  return {
    ok: true,
    generatedAt: parsed.data.generated_at,
    counts: parsed.data.counts,
    open,
    items: items.slice(0, WARDEN_ITEMS_CAP),
    itemsTruncated: parsed.data.truncated === true || items.length > WARDEN_ITEMS_CAP,
    terminal24h: parsed.data.terminal_24h,
    fetchedAt,
  };
}

// ── warden block (opt-in via server/lib/agents.ts's renderText `opts.warden`) ────────────────
//
// warden's ledger states are strings, not agents.ts's own AgentState/Recommendation enums —
// its "needs attention" bucket is a fixed pair named directly rather than routed through
// agents.ts's categoryColor/effectiveCategory, which only know about agent states.
const WARDEN_IN_FLIGHT_STATES = new Set([
  "investigating",
  "implementing",
  "validating",
  "liveness_pending",
]);
const WARDEN_MAX_ITEM_LINES = 8;

/** `needs_human` and `merge_blocked` share bucket 0 — a human is needed to resolve either one,
 *  so neither is more urgent than the other — then any in-flight state, then everything else.
 *  Items arrive `updated_at DESC` from warden, and a stable sort by (priority, original index)
 *  keeps that order within each bucket. */
function wardenItemPriority(state: string): number {
  if (state === "needs_human" || state === "merge_blocked") return 0;
  if (WARDEN_IN_FLIGHT_STATES.has(state)) return 1;
  return 2;
}

export interface RenderWardenBlockOptions {
  /** `opts.color` from renderText — SGR spans on/off. */
  color: boolean;
  /** `lineMax` already resolved from `opts.cols` (or the legacy fixed default) by renderText. */
  lineMax: number;
  /** The snapshot's `generatedAt`, so item ages read relative to the same instant as the rest
   *  of the render rather than `Date.now()` at render time. */
  generatedAt: number;
}

/** The warden block appended after the agent roster by server/lib/agents.ts's `renderText`,
 *  which only calls this and pushes the returned lines — extracted here so the block's own
 *  priority/colour rules live next to the type they render. Every warden-sourced string that
 *  reaches this block (`state`, `repo`, `title`, and the unreachable-board `error`) is
 *  attacker-influenced — an alert or a GitHub issue title reaches warden's ledger — so each is
 *  passed through `stripControlBytes` before it touches a coloured terminal pane. */
function columnWidth(values: string[], min: number, max: number): number {
  const longest = values.reduce((acc, v) => Math.max(acc, v.length), 0);
  return Math.min(max, Math.max(min, longest));
}

export function renderWardenBlock(warden: WardenBoard, opts: RenderWardenBlockOptions): string[] {
  const { color, lineMax, generatedAt } = opts;

  if (!warden.ok) {
    const line = `warden · unreachable (${stripControlBytes(warden.error)})`;
    return [clampLine(line, lineMax)];
  }

  const lines: string[] = [];
  const needsHuman = warden.counts.needs_human;
  const mergeBlocked = warden.counts.merge_blocked;
  const inFlightCount =
    warden.counts.investigating +
    warden.counts.implementing +
    warden.counts.validating +
    warden.counts.liveness_pending;
  const header =
    `warden · ${warden.open} open · needs_human ${needsHuman} · ` +
    `merge_blocked ${mergeBlocked} · in flight ${inFlightCount}`;
  lines.push(
    color ? clampVisible(`${BOLD}${header}${RESET}`, lineMax) : clampLine(header, lineMax),
  );

  const ordered = warden.items
    .map((item, index) => ({ item, index }))
    .toSorted((a, b) => {
      const pa = wardenItemPriority(a.item.state);
      const pb = wardenItemPriority(b.item.state);
      return pa !== pb ? pa - pb : a.index - b.index;
    })
    .map((entry) => entry.item);
  const shown = ordered.slice(0, WARDEN_MAX_ITEM_LINES).map((raw) => ({
    state: stripControlBytes(raw.state),
    repo: stripControlBytes(raw.repo),
    title: stripControlBytes(raw.title),
    rawState: raw.state,
    updatedAt: raw.updatedAt,
  }));
  // Column widths fit the longest value actually shown (bounded), so a
  // `merge_blocked` or `liveness_pending` is never clipped to a stub the way a
  // fixed 12-char column clipped it — measured on the live pane.
  const stateWidth = columnWidth(
    shown.map((s) => s.state),
    8,
    16,
  );
  const repoWidth = columnWidth(
    shown.map((s) => s.repo),
    8,
    20,
  );

  for (const raw of shown) {
    const { state, repo, title } = raw;
    const updatedMs = Date.parse(raw.updatedAt);
    const age = relativeAge(Number.isNaN(updatedMs) ? null : updatedMs, generatedAt);
    const statePadded = state.slice(0, stateWidth).padEnd(stateWidth);
    const repoPadded = repo.slice(0, repoWidth).padEnd(repoWidth);
    const suffix = ` [${age}]`;
    const fixedWidth = 2 + statePadded.length + 1 + repoPadded.length + 1 + suffix.length;
    const truncatedTitle = truncate(title, Math.max(MIN_TITLE_CHARS, lineMax - fixedWidth));
    const base = `  ${statePadded} ${repoPadded} ${truncatedTitle}${suffix}`;

    if (color) {
      const needsAttention = raw.rawState === "needs_human" || raw.rawState === "merge_blocked";
      const spanColor = needsAttention
        ? BOLD_RED
        : WARDEN_IN_FLIGHT_STATES.has(raw.rawState)
          ? GREEN
          : "";
      lines.push(clampVisible(spanColor ? `${spanColor}${base}${RESET}` : base, lineMax));
    } else {
      lines.push(clampLine(base, lineMax));
    }
  }

  if (ordered.length > WARDEN_MAX_ITEM_LINES) {
    lines.push(clampLine(`  … ${ordered.length - WARDEN_MAX_ITEM_LINES} more`, lineMax));
  }

  return lines;
}
