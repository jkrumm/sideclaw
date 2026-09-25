import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import { logger } from "../mcp/logger.ts";
import { IDLE_TIMEOUT_MS } from "./idle-timeout.ts";

// ── IU OpenAI transport ───────────────────────────────────────────────────────
//
// Direct, stateless HTTPS calls to the IU unified endpoint's OpenAI transport
// (`/openai/v1/...`). These bypass session-runner entirely — they are plain
// fetches, billed IU per-token, zero Max quota.
//
// Because they bypass session-runner, nothing writes their usage to the normal
// sideclaw-sessions attribution log. `recordIuUsage()` writes a separate NDJSON
// sink instead, which the usage-tracker's `sideclaw-iu` collector ingests.

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** NDJSON usage sink consumed by the usage-tracker's `sideclaw-iu` collector. Resolved fresh
 *  on every call (not cached at module load) — a test that sets `SIDECLAW_IU_USAGE_LOG` AFTER
 *  this module has already been imported (e.g. transitively, via `server/lib/ocr.ts`, from an
 *  earlier test file in the same bun test process) would otherwise leak rows into the real
 *  sink because a module-level constant had already baked in the default path. */
function usageSinkPath(): string {
  return (
    process.env.SIDECLAW_IU_USAGE_LOG ??
    join(homedir(), ".local", "share", "usage-tracker", "sideclaw-iu.jsonl")
  );
}

/**
 * Token usage for one IU call — the single source of truth for both the
 * `IuUsage` type and the `usage` field every multimodal tool exposes in its MCP
 * output schema. Import this rather than re-declaring the shape, so a new field
 * can't land in the type while the tool contracts silently drop it.
 */
export const IU_USAGE_SCHEMA = z.object({
  inputTokens: z.number().describe("Prompt tokens consumed."),
  outputTokens: z.number().describe("Visible completion tokens produced."),
  reasoningTokens: z
    .number()
    .default(0)
    .describe(
      "Thinking tokens, billed at the output rate. Read from " +
        "completion_tokens_details.reasoning_tokens where the vendor reports it (OpenAI, " +
        "which folds it inside completion_tokens) and otherwise derived as " +
        "total - input - output (Gemini, which reports it nowhere). 0 for non-thinking models.",
    ),
  totalTokens: z.number().describe("Total tokens: input + output + reasoning."),
  cacheReadTokens: z
    .number()
    .default(0)
    .describe(
      "Prompt tokens served from cache, read from prompt_tokens_details.cached_tokens. A " +
        "SUBSET of inputTokens (OpenAI convention: cached_tokens <= prompt_tokens), not " +
        "additional tokens. 0 where the vendor doesn't report it.",
    ),
  costUsd: z
    .number()
    .nullable()
    .default(null)
    .describe(
      "The gateway's own reported cost for this call in USD (usage.cost), when the model " +
        "id reports it — DeepSeek ids currently do over /openai/v1/chat/completions, GPT/" +
        "Gemini ids don't. Never computed locally; null when absent.",
    ),
});

export type IuUsage = z.infer<typeof IU_USAGE_SCHEMA>;

interface IuConfig {
  key: string;
  openaiBase: string;
  anthropicBase: string;
}

let configCache: IuConfig | null = null;

async function keychain(service: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", service, "-w"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const trimmed = out.trim();
    return code === 0 && trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

/** Resolve the IU key + OpenAI base. Env overrides win; otherwise read from the
 * Keychain entries `make setup` caches (`claude-sdk-api-key`, `claude-sdk-base-url`).
 * The base ends in `/anthropic`; the OpenAI transport is the same host with
 * `/openai/v1` — derived by string replace, never hardcoded. Cached after first read. */
export async function getIuConfig(): Promise<IuConfig> {
  if (configCache) return configCache;

  const key = process.env.IU_API_KEY ?? (await keychain("claude-sdk-api-key"));
  const baseRaw = process.env.IU_BASE_URL ?? (await keychain("claude-sdk-base-url"));

  if (!key) {
    throw new Error(
      "IU API key not found. Set IU_API_KEY or cache it in the Keychain as 'claude-sdk-api-key' (run `make setup` in ~/SourceRoot/dotfiles).",
    );
  }
  if (!baseRaw) {
    throw new Error(
      "IU base URL not found. Set IU_BASE_URL or cache it in the Keychain as 'claude-sdk-base-url'.",
    );
  }

  const openaiBase = baseRaw.replace(/\/anthropic\/?$/, "/openai/v1");
  if (openaiBase === baseRaw) {
    throw new Error(
      `Cannot derive the OpenAI base from '${baseRaw}' — expected it to end in '/anthropic'.`,
    );
  }

  configCache = { key, openaiBase, anthropicBase: baseRaw };
  return configCache;
}

interface FetchOpts {
  /** Idle-watchdog budget: aborted only once this long passes with no SSE token received
   * (reset on every chunk) — not a wall-clock ceiling on the whole call. A reasoning model on
   * a hard prompt can legitimately run past any fixed total-time budget as long as it keeps
   * producing output; only silence for this long means "wedged". Defaults to the same
   * IDLE_TIMEOUT_MS the session runner's subprocess watchdog uses. */
  idleTimeoutMs?: number;
  attempts?: number;
}

interface IuStreamResult {
  text: string;
  usage?: IuUsage;
  id?: string;
  model?: string;
}

/** POST JSON to the IU OpenAI transport as an SSE stream (`stream: true`,
 * `stream_options.include_usage: true` — confirmed live against the IU gateway: it forwards
 * standard OpenAI chat-completion-chunk events and a final usage-only chunk before `[DONE]`)
 * and accumulate the full text + usage. Idle-watchdog only, no wall-clock ceiling — see
 * FetchOpts.idleTimeoutMs. 503/429/5xx and network errors on the initial request back off
 * (0.5s, 1.5s) and retry; 410 (dead model) fails fast. */
async function iuFetch(
  path: string,
  body: Record<string, unknown>,
  opts: FetchOpts = {},
): Promise<IuStreamResult> {
  const { key, openaiBase } = await getIuConfig();
  const attempts = opts.attempts ?? 3;
  const idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const streamBody = { ...body, stream: true, stream_options: { include_usage: true } };
  let lastErr: Error | undefined;

  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idledOut = false;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idledOut = true;
        controller.abort();
      }, idleTimeoutMs);
    };

    let res: Response;
    try {
      armIdle();
      res = await fetch(`${openaiBase}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(streamBody),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(idleTimer);
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (i < attempts - 1) {
        await Bun.sleep(500 * 3 ** i);
        continue;
      }
      throw lastErr ?? new Error("IU request failed after retries");
    }

    if (!res.ok) {
      clearTimeout(idleTimer);
      const text = await res.text().catch(() => "");
      if (res.status === 410) {
        throw new Error(
          `Model deprecated (410). Use a current model (image gen: gpt-image-{1,1-mini,1.5,2}). Detail: ${text.slice(0, 200)}`,
        );
      }
      if (RETRYABLE_STATUS.has(res.status) && i < attempts - 1) {
        lastErr = new Error(`IU ${res.status}: ${text.slice(0, 200)}`);
        await Bun.sleep(500 * 3 ** i);
        continue;
      }
      throw new Error(`IU request failed (${res.status}): ${text.slice(0, 300)}`);
    }

    try {
      const result = await readSseStream(res, armIdle);
      clearTimeout(idleTimer);
      return result;
    } catch (err) {
      clearTimeout(idleTimer);
      if (idledOut) {
        throw new Error(`IU stream idle-timed-out after ${idleTimeoutMs}ms with no token`, {
          cause: err,
        });
      }
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (i < attempts - 1) {
        await Bun.sleep(500 * 3 ** i);
        continue;
      }
      throw lastErr ?? new Error("IU request failed after retries");
    }
  }

  throw lastErr ?? new Error("IU request failed after retries");
}

/** Decode one OpenAI-style SSE response body into accumulated text + usage. Calls
 * `onChunk()` after every decoded chunk so the caller's idle watchdog resets on each token,
 * not just on the initial connect. */
async function readSseStream(res: Response, onChunk: () => void): Promise<IuStreamResult> {
  if (!res.body) throw new Error("IU stream response had no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let usage: IuUsage | undefined;
  let id: string | undefined;
  let model: string | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk();
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice("data:".length).trim();
      if (!payload || payload === "[DONE]") continue;
      const chunk = JSON.parse(payload) as {
        id?: string;
        model?: string;
        choices?: { delta?: { content?: string } }[];
        usage?: unknown;
      };
      if (chunk.id) id = chunk.id;
      if (chunk.model) model = chunk.model;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) text += delta;
      if (chunk.usage) usage = normalizeUsage(chunk.usage);
    }
  }

  return { text, usage, id, model };
}

/** Coerce a reported token count to a usable number; vendors occasionally omit
 * fields, and the counts feed arithmetic. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Map a vendor usage object onto IuUsage.
 *
 * Thinking tokens bill at the output rate but reach us two different ways, and
 * the gateway passes each vendor's convention through untouched:
 *
 *  - **OpenAI (gpt-5.x)** reports `completion_tokens_details.reasoning_tokens`
 *    and folds that count *inside* `completion_tokens`, so
 *    `total = prompt + completion`. Reading it and subtracting from the
 *    completion count splits visible output from thinking without inventing
 *    tokens. Measured on gpt-5.6-terra: a 168-token answer at
 *    `reasoning_effort: high` carried ~4.3k reasoning tokens.
 *  - **Gemini** reports no details object at all, and its `thoughtsTokenCount`
 *    sits *outside* `candidatesTokenCount`
 *    (`totalTokenCount = prompt + candidates + thoughts`), so the thinking
 *    spend is visible only as the leftover `total - prompt - completion`. It is
 *    substantial — a 133-token answer routinely hides ~3k thinking tokens.
 *
 * Handling both keeps the invariant `input + output + reasoning === total` in
 * either convention, so a caller can price output and reasoning at the same
 * rate and count every token exactly once. Non-thinking models report no
 * details and no leftover, yielding 0 (gpt-image-2 reconciles exactly).
 */
function normalizeUsage(raw: unknown): IuUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;

  const inputTokens = num(u.prompt_tokens ?? u.input_tokens);
  const completionTokens = num(u.completion_tokens ?? u.output_tokens);
  const totalTokens =
    typeof u.total_tokens === "number" ? num(u.total_tokens) : inputTokens + completionTokens;

  // OpenAI convention: reported, and already counted inside completion_tokens.
  const details = (u.completion_tokens_details ?? u.output_tokens_details) as
    | Record<string, unknown>
    | undefined;
  const reported = details && typeof details === "object" ? num(details.reasoning_tokens) : 0;

  // Gemini convention: unreported, and sitting outside completion_tokens.
  const external = Math.max(0, totalTokens - inputTokens - completionTokens);

  // Cache reads: a subset of prompt_tokens (verified: cached_tokens <= prompt_tokens),
  // reported by DeepSeek ids on this gateway; absent elsewhere.
  const promptDetails = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const cacheReadTokens =
    promptDetails && typeof promptDetails === "object" ? num(promptDetails.cached_tokens) : 0;

  // The gateway's own cost, when the model id reports it — never derived locally.
  const costUsd = typeof u.cost === "number" && Number.isFinite(u.cost) ? u.cost : null;

  return {
    inputTokens,
    outputTokens: Math.max(0, completionTokens - reported),
    reasoningTokens: reported + external,
    totalTokens,
    cacheReadTokens,
    costUsd,
  };
}

/** Append one usage row to the NDJSON sink. Best-effort: telemetry failure must
 * never break the tool, but it is logged (not silently dropped). Exported — `server/lib/ocr.ts`
 * bypasses `visionRead`/`textComplete` (it shells out to the `ocr` CLI, not a direct fetch)
 * but still bills IU per-token and needs the same sink. */
export async function recordIuUsage(rec: {
  tool: string;
  model: string;
  usage?: IuUsage;
  requestId?: string;
  latencyMs: number;
  bytes?: number;
  /** Overrides `usage?.cacheReadTokens` — for callers (e.g. `server/lib/ocr.ts`) that never
   *  built a full `IuUsage` object but still know the cache-read count from their own summary. */
  cacheReadTokens?: number;
  /** No `IuUsage` field carries this (the IU OpenAI transport reports no cache-write
   *  convention) — callers that know it (ocr's own summary) pass it directly. Defaults to 0. */
  cacheWriteTokens?: number;
  /** Overrides `usage?.costUsd`. Pass `null` explicitly for a caller that knows for certain
   *  no cost is available (e.g. ocr, which reports none) rather than leaving it to fall
   *  through to `usage?.costUsd`. */
  costUsd?: number | null;
  outcome?: "ok" | "error";
}): Promise<void> {
  const sink = usageSinkPath();
  try {
    await mkdir(dirname(sink), { recursive: true });
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        source: "sideclaw-iu",
        request_id: rec.requestId ?? crypto.randomUUID(),
        tool: rec.tool,
        model: rec.model,
        billing: "iu",
        // `input_tokens` is the TOTAL prompt tokens INCLUDING cache reads (OpenAI convention,
        // which is what both the gateway and ocr report; verified: cached_tokens <=
        // prompt_tokens) — the usage-tracker collector subtracts `cache_read_tokens` to get
        // the uncached count. Never subtract here.
        input_tokens: rec.usage?.inputTokens ?? 0,
        output_tokens: rec.usage?.outputTokens ?? 0,
        reasoning_tokens: rec.usage?.reasoningTokens ?? 0,
        total_tokens: rec.usage?.totalTokens ?? 0,
        cache_read_tokens: rec.cacheReadTokens ?? rec.usage?.cacheReadTokens ?? 0,
        cache_write_tokens: rec.cacheWriteTokens ?? 0,
        cost_usd: rec.costUsd !== undefined ? rec.costUsd : (rec.usage?.costUsd ?? null),
        outcome: rec.outcome ?? "ok",
        latency_ms: rec.latencyMs,
        bytes: rec.bytes ?? null,
      }) + "\n";
    await appendFile(sink, line);
  } catch (err) {
    logger.warn({ event: "iu.usage.sink_failed", err, sink }, "iu usage sink append failed");
  }
}

export interface VisionResult {
  text: string;
  model: string;
  latencyMs: number;
  usage?: IuUsage;
}

/** Single vision call: image (base64) + prompt → text. `model` comes from the caller's
 * route (server/lib/routing.ts) — no default here, so an env override cannot be bypassed.
 * Streamed under the hood; `timeoutMs` is an idle-watchdog budget (no token for this long),
 * not a ceiling on the whole call — see FetchOpts.idleTimeoutMs. */
export async function visionRead(opts: {
  imageBase64: string;
  mimeType?: string;
  prompt: string;
  model: string;
  tool?: string;
  timeoutMs?: number;
}): Promise<VisionResult> {
  const model = opts.model;
  const mimeType = opts.mimeType ?? "image/png";
  const t0 = performance.now();

  // No `temperature` on the wire, deliberately — same reasoning as textComplete's: the IU
  // gateway 503s on a non-default temperature for the gpt-5.x family, and VISION may be
  // re-pointed at one of those models. Sampled at the provider's default.
  const data = await iuFetch(
    "/chat/completions",
    {
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: opts.prompt },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${opts.imageBase64}` },
            },
          ],
        },
      ],
    },
    { idleTimeoutMs: opts.timeoutMs },
  );

  const latencyMs = Math.round(performance.now() - t0);

  if (!data.text) {
    // A paid call still bills tokens even when the response carries no text — record it
    // before throwing, or the spend is lost.
    await recordIuUsage({
      tool: opts.tool ?? "read_image",
      model,
      usage: data.usage,
      requestId: data.id,
      latencyMs,
      outcome: "error",
    });
    throw new Error("Vision call returned no content.");
  }

  await recordIuUsage({
    tool: opts.tool ?? "read_image",
    model,
    usage: data.usage,
    requestId: data.id,
    latencyMs,
  });
  return { text: data.text, model, latencyMs, usage: data.usage };
}

export interface TextCompleteResult {
  text: string;
  model: string;
  latencyMs: number;
  usage?: IuUsage;
}

/** Single non-agentic text completion via the IU OpenAI transport. Useful for
 * cross-family review/critique calls that don't need a `claude -p` agent loop:
 * one HTTPS call, one JSON response, billed IU per-token. `model` comes from the
 * caller's route (server/lib/routing.ts). Pass `tool` to tag the usage-tracker row.
 *
 * `temperature` is never sent — no caller needs it, and reasoning models (the gpt-5.x
 * family) accept only the default (1) and reject any explicit value with a 400 — which
 * the IU gateway relays as a 503, i.e. one iuFetch treats as retryable and burns every
 * attempt on. Sending nothing is the only option that works across both thinking and
 * non-thinking models.
 *
 * `reasoningEffort` only goes on the wire when passed. It is a gpt-5.x parameter ("none" |
 * "low" | "medium" | "high" | "xhigh"); the gateway rejects an unknown value, and
 * non-reasoning models reject the parameter itself. Omitting it on a gpt-5.x model is NOT
 * a neutral default — it behaves as "none", i.e. the reasoning model answers with no
 * thinking at all while still billing at its reasoning-tier rate. Set it explicitly to get
 * what you pay for.
 *
 * `maxTokens` is sent as `max_completion_tokens` — the OpenAI leg's current parameter name;
 * `max_tokens` is the deprecated one and some models on this gateway reject it outright.
 *
 * Streamed under the hood; `timeoutMs` is an idle-watchdog budget (no token for this long,
 * default IDLE_TIMEOUT_MS = 5 min), not a ceiling on the whole call — a slow-but-progressing
 * reasoning completion is never killed for taking a long time, only for going silent. */
export async function textComplete(opts: {
  prompt: string;
  model: string;
  tool?: string;
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<TextCompleteResult> {
  const model = opts.model;
  const t0 = performance.now();

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: opts.prompt }],
  };
  if (opts.reasoningEffort !== undefined) body.reasoning_effort = opts.reasoningEffort;
  if (opts.maxTokens) body.max_completion_tokens = opts.maxTokens;

  const data = await iuFetch("/chat/completions", body, { idleTimeoutMs: opts.timeoutMs });
  const latencyMs = Math.round(performance.now() - t0);

  if (!data.text) {
    // A paid call still bills tokens even when the response carries no text — record it
    // before throwing, or the spend is lost.
    await recordIuUsage({
      tool: opts.tool ?? "text_complete",
      model,
      usage: data.usage,
      requestId: data.id,
      latencyMs,
      outcome: "error",
    });
    throw new Error("Text completion returned no content.");
  }

  await recordIuUsage({
    tool: opts.tool ?? "text_complete",
    model,
    usage: data.usage,
    requestId: data.id,
    latencyMs,
  });
  return { text: data.text, model, latencyMs, usage: data.usage };
}
