import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import { logger } from "../mcp/logger.ts";

// ── IU OpenAI transport ───────────────────────────────────────────────────────
//
// Direct, stateless HTTPS calls to the IU unified endpoint's OpenAI transport
// (`/openai/v1/...`). These bypass the LiteLLM bridge and session-runner
// entirely — they are plain fetches, billed IU per-token, zero Max quota.
//
// Because they bypass the bridge, the usage-tracker's litellm collector never
// sees them. `recordIuUsage()` mirrors the bridge's NDJSON shape into a separate
// sink so a future usage-tracker `sideclaw-iu` collector can ingest the spend.

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// NDJSON usage sink. Matches the per-line shape the litellm collector reads, so a
// usage-tracker `sideclaw-iu` collector can be a near-copy of the litellm one.
const USAGE_SINK =
  process.env.SIDECLAW_IU_USAGE_LOG ??
  join(homedir(), ".local", "share", "usage-tracker", "sideclaw-iu.jsonl");

export interface IuUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface IuConfig {
  key: string;
  openaiBase: string;
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

  configCache = { key, openaiBase };
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

function normalizeUsage(raw: unknown): IuUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, number>;
  const inputTokens = u.prompt_tokens ?? u.input_tokens ?? 0;
  const outputTokens = u.completion_tokens ?? u.output_tokens ?? 0;
  const totalTokens = u.total_tokens ?? inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
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
 * gemini-3.5-flash. Pass `tool` to tag the usage-tracker row. */
export async function textComplete(opts: {
  prompt: string;
  model?: string;
  tool?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<TextCompleteResult> {
  const model = opts.model ?? "gemini-3.5-flash";
  const t0 = performance.now();

  const body: Record<string, unknown> = {
    model,
    temperature: opts.temperature ?? 0,
    messages: [{ role: "user", content: opts.prompt }],
  };
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

export interface GenerateImageResult {
  path: string;
  model: string;
  latencyMs: number;
  usage?: IuUsage;
}

/** Generate one image and write the decoded PNG to disk. Default model
 * gpt-image-2 (routes to the OpenAI vendor key — US; fine for generated assets,
 * not for PII). */
export async function generateImage(opts: {
  prompt: string;
  model?: string;
  size?: string;
  outputPath?: string;
}): Promise<GenerateImageResult> {
  const model = opts.model ?? "gpt-image-2";
  const size = opts.size ?? "1024x1024";
  const t0 = performance.now();

  const data = (await iuFetch(
    "/images/generations",
    { model, prompt: opts.prompt, n: 1, size },
    { timeoutMs: 120_000 },
  )) as { id?: string; data?: { b64_json?: string }[]; usage?: unknown };

  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("Image generation returned no b64_json payload.");

  const bytes = Buffer.from(b64, "base64");
  // PNG magic: 89 50 4E 47
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) {
    throw new Error("Generated image is not a valid PNG (bad magic bytes).");
  }

  const outputPath = opts.outputPath ?? join(tmpdir(), `sideclaw-image-${Date.now()}.png`);
  await Bun.write(outputPath, bytes);

  const usage = normalizeUsage(data.usage);
  const latencyMs = Math.round(performance.now() - t0);
  await recordIuUsage({
    tool: "generate_image",
    model,
    usage,
    requestId: data.id,
    latencyMs,
    bytes: bytes.length,
  });
  return { path: outputPath, model, latencyMs, usage };
}
