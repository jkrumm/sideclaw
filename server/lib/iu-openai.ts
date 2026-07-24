import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import { logger } from "../mcp/logger.ts";

// ── IU OpenAI transport ───────────────────────────────────────────────────────
//
// Direct, stateless HTTPS calls to the IU unified endpoint's OpenAI transport
// (`/openai/v1/...`). These bypass the LiteLLM bridge and session-runner
// entirely — they are plain fetches, billed IU per-token, zero Max quota.
//
// Because they bypass the bridge, the usage-tracker's litellm collector never
// sees them. `recordIuUsage()` mirrors the bridge's NDJSON shape into a separate
// sink, which the usage-tracker's `sideclaw-iu` collector ingests.

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// NDJSON usage sink. Matches the per-line shape the litellm collector reads, so a
// usage-tracker `sideclaw-iu` collector can be a near-copy of the litellm one.
const USAGE_SINK =
  process.env.SIDECLAW_IU_USAGE_LOG ??
  join(homedir(), ".local", "share", "usage-tracker", "sideclaw-iu.jsonl");

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
  timeoutMs?: number;
  attempts?: number;
}

/** POST JSON to the IU OpenAI transport with bounded retry. 503/429/5xx and
 * network errors back off (0.5s, 1.5s) and retry; 410 (dead model) fails fast. */
async function iuFetch(
  path: string,
  body: Record<string, unknown>,
  opts: FetchOpts = {},
): Promise<unknown> {
  const { key, openaiBase } = await getIuConfig();
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  let lastErr: Error | undefined;

  for (let i = 0; i < attempts; i++) {
    let res: Response;
    try {
      res = await fetch(`${openaiBase}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (i < attempts - 1) {
        await Bun.sleep(500 * 3 ** i);
        continue;
      }
      throw lastErr ?? new Error("IU request failed after retries");
    }

    if (res.ok) return res.json();

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

  throw lastErr ?? new Error("IU request failed after retries");
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

  return {
    inputTokens,
    outputTokens: Math.max(0, completionTokens - reported),
    reasoningTokens: reported + external,
    totalTokens,
  };
}

/** Append one usage row to the NDJSON sink. Best-effort: telemetry failure must
 * never break the tool, but it is logged (not silently dropped). */
async function recordIuUsage(rec: {
  tool: string;
  model: string;
  usage?: IuUsage;
  requestId?: string;
  latencyMs: number;
  bytes?: number;
}): Promise<void> {
  try {
    await mkdir(dirname(USAGE_SINK), { recursive: true });
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        source: "sideclaw-iu",
        request_id: rec.requestId ?? crypto.randomUUID(),
        tool: rec.tool,
        model: rec.model,
        billing: "iu",
        input_tokens: rec.usage?.inputTokens ?? 0,
        output_tokens: rec.usage?.outputTokens ?? 0,
        reasoning_tokens: rec.usage?.reasoningTokens ?? 0,
        total_tokens: rec.usage?.totalTokens ?? 0,
        latency_ms: rec.latencyMs,
        bytes: rec.bytes ?? null,
      }) + "\n";
    await appendFile(USAGE_SINK, line);
  } catch (err) {
    logger.warn(
      { event: "iu.usage.sink_failed", err, sink: USAGE_SINK },
      "iu usage sink append failed",
    );
  }
}

export interface VisionResult {
  text: string;
  model: string;
  latencyMs: number;
  usage?: IuUsage;
}

/** Single vision call: image (base64) + prompt → text. Default model
 * gemini-3.5-flash (fast, strong on dense diagrams). */
export async function visionRead(opts: {
  imageBase64: string;
  mimeType?: string;
  prompt: string;
  model?: string;
  tool?: string;
  timeoutMs?: number;
}): Promise<VisionResult> {
  const model = opts.model ?? "gemini-3.5-flash";
  const mimeType = opts.mimeType ?? "image/png";
  const t0 = performance.now();

  const data = (await iuFetch(
    "/chat/completions",
    {
      model,
      temperature: 0,
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
    { timeoutMs: opts.timeoutMs ?? 90_000 },
  )) as {
    id?: string;
    choices?: { message?: { content?: string } }[];
    usage?: unknown;
  };

  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("Vision call returned no content.");
  const usage = normalizeUsage(data.usage);
  const latencyMs = Math.round(performance.now() - t0);

  await recordIuUsage({
    tool: opts.tool ?? "read_image",
    model,
    usage,
    requestId: data.id,
    latencyMs,
  });
  return { text, model, latencyMs, usage };
}

export interface TextCompleteResult {
  text: string;
  model: string;
  latencyMs: number;
  usage?: IuUsage;
}

/** Single non-agentic text completion via the IU OpenAI transport. Useful for
 * cross-family review/critique calls that don't need a `claude -p` agent loop:
 * one HTTPS call, one JSON response, billed IU per-token. Default model
 * gemini-3.5-flash. Pass `tool` to tag the usage-tracker row.
 *
 * `temperature` is omitted from the request unless explicitly passed. Reasoning
 * models (the gpt-5.x family) accept only the default (1) and reject any
 * explicit value with a 400 — which the IU gateway relays as a 503, i.e. one
 * iuFetch treats as retryable and burns every attempt on. Sending nothing is
 * the only option that works across both thinking and non-thinking models.
 *
 * `reasoningEffort` likewise only goes on the wire when passed. It is a gpt-5.x
 * parameter ("none" | "low" | "medium" | "high" | "xhigh"); the gateway rejects
 * an unknown value, and non-reasoning models reject the parameter itself.
 * Omitting it on a gpt-5.x model is NOT a neutral default — it behaves as
 * "none", i.e. the reasoning model answers with no thinking at all while still
 * billing at its reasoning-tier rate. Set it explicitly to get what you pay for. */
export async function textComplete(opts: {
  prompt: string;
  model?: string;
  tool?: string;
  temperature?: number;
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<TextCompleteResult> {
  const model = opts.model ?? "gemini-3.5-flash";
  const t0 = performance.now();

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: opts.prompt }],
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.reasoningEffort !== undefined) body.reasoning_effort = opts.reasoningEffort;
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const data = (await iuFetch("/chat/completions", body, {
    timeoutMs: opts.timeoutMs ?? 90_000,
  })) as { id?: string; choices?: { message?: { content?: string } }[]; usage?: unknown };

  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("Text completion returned no content.");
  const usage = normalizeUsage(data.usage);
  const latencyMs = Math.round(performance.now() - t0);

  await recordIuUsage({
    tool: opts.tool ?? "text_complete",
    model,
    usage,
    requestId: data.id,
    latencyMs,
  });
  return { text, model, latencyMs, usage };
}
