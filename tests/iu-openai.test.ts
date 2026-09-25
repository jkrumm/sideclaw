// Bounds of server/lib/iu-openai.ts's request-body construction for textComplete and
// visionRead. iuFetch calls the global `fetch` directly (no injected fetchImpl like
// warden-board.ts's boundary), so this stubs `globalThis.fetch` — same functional-response
// shape the rest of the repo uses (`(async (...) => Response) as typeof fetch`), just at the
// global rather than a parameter.
//
// SIDECLAW_IU_USAGE_LOG/IU_API_KEY/IU_BASE_URL are set before the first import below so
// recordIuUsage's NDJSON sink never touches the real ~/.local/share path and getIuConfig
// never falls through to the Keychain.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SIDECLAW_IU_USAGE_LOG = join(tmpdir(), `sideclaw-iu-openai-test-${Date.now()}.jsonl`);
process.env.IU_API_KEY = "test-key";
process.env.IU_BASE_URL = "https://iu.example.com/anthropic";

const { textComplete, visionRead, recordIuUsage } = await import("../server/lib/iu-openai.ts");

const originalUsageLog = process.env.SIDECLAW_IU_USAGE_LOG;

/** A fresh temp sink path for a test that needs to read back exactly one row, rather than
 *  sharing the file-level sink every other test in this suite appends to. */
function uniqueSink(): string {
  return join(tmpdir(), `sideclaw-iu-openai-test-row-${Date.now()}-${Math.random()}.jsonl`);
}

async function readLastRow(sink: string): Promise<Record<string, unknown>> {
  const text = await Bun.file(sink).text();
  const lines = text.trim().split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "{}");
}

/** One SSE response carrying a single content chunk, terminated with [DONE] — enough for
 *  readSseStream to accumulate `text` and return. */
function sseResponse(text: string): Response {
  const chunk = {
    id: "chatcmpl-test",
    model: "test-model",
    choices: [{ delta: { content: text } }],
  };
  const body = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

let lastBody: Record<string, unknown> | undefined;
const originalFetch = globalThis.fetch;

function stubFetch(response: Response) {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    lastBody = JSON.parse(init?.body as string);
    return response;
  }) as typeof fetch;
}

beforeEach(() => {
  lastBody = undefined;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUsageLog !== undefined) process.env.SIDECLAW_IU_USAGE_LOG = originalUsageLog;
});

/** A usage-only chunk, the shape the SSE stream carries just before `[DONE]`
 *  (`stream_options.include_usage: true`) — the same JSON `readSseStream` decodes into
 *  `normalizeUsage`. */
function sseResponseWithUsage(text: string, usage: Record<string, unknown>): Response {
  const contentChunk = {
    id: "chatcmpl-test",
    model: "test-model",
    choices: [{ delta: { content: text } }],
  };
  const usageChunk = { id: "chatcmpl-test", model: "test-model", choices: [], usage };
  const body =
    `data: ${JSON.stringify(contentChunk)}\n\n` +
    `data: ${JSON.stringify(usageChunk)}\n\n` +
    `data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("textComplete — request body", () => {
  test("sends max_completion_tokens, never max_tokens, when maxTokens is passed", async () => {
    stubFetch(sseResponse("hi"));
    await textComplete({ prompt: "hello", model: "gpt-5.6-terra", maxTokens: 4096 });
    expect(lastBody?.max_completion_tokens).toBe(4096);
    expect(lastBody?.max_tokens).toBeUndefined();
  });

  test("omits max_completion_tokens entirely when maxTokens is not passed", async () => {
    stubFetch(sseResponse("hi"));
    await textComplete({ prompt: "hello", model: "gpt-5.6-terra" });
    expect(lastBody?.max_completion_tokens).toBeUndefined();
    expect(lastBody?.max_tokens).toBeUndefined();
  });

  test("sends reasoning_effort only when passed", async () => {
    stubFetch(sseResponse("hi"));
    await textComplete({ prompt: "hello", model: "gpt-5.6-terra", reasoningEffort: "high" });
    expect(lastBody?.reasoning_effort).toBe("high");
  });

  test("omits reasoning_effort when not passed", async () => {
    stubFetch(sseResponse("hi"));
    await textComplete({ prompt: "hello", model: "gpt-5.6-terra" });
    expect(lastBody?.reasoning_effort).toBeUndefined();
  });

  test("never sends a temperature key", async () => {
    stubFetch(sseResponse("hi"));
    await textComplete({ prompt: "hello", model: "gpt-5.6-terra" });
    expect(lastBody?.temperature).toBeUndefined();
  });
});

describe("visionRead — request body", () => {
  test("never sends a temperature key", async () => {
    stubFetch(sseResponse("a description"));
    await visionRead({ imageBase64: "Zm9v", prompt: "describe this", model: "gemini-3.5-flash" });
    expect(lastBody?.temperature).toBeUndefined();
  });
});

describe("normalizeUsage — via textComplete's parsed usage", () => {
  test("reads prompt_tokens_details.cached_tokens into cacheReadTokens and usage.cost into costUsd", async () => {
    stubFetch(
      sseResponseWithUsage("hi", {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 40 },
        cost: 0.0012,
      }),
    );
    const result = await textComplete({ prompt: "hello", model: "DeepSeek-V4-Flash" });
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.cacheReadTokens).toBe(40);
    expect(result.usage?.costUsd).toBe(0.0012);
  });

  test("defaults cacheReadTokens to 0 and costUsd to null when the vendor reports neither", async () => {
    stubFetch(
      sseResponseWithUsage("hi", { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 }),
    );
    const result = await textComplete({ prompt: "hello", model: "gpt-5.6-terra" });
    expect(result.usage?.cacheReadTokens).toBe(0);
    expect(result.usage?.costUsd).toBeNull();
  });
});

describe("recordIuUsage — row shape", () => {
  test("writes cache_read_tokens/cache_write_tokens/cost_usd/outcome with the documented defaults", async () => {
    const sink = uniqueSink();
    process.env.SIDECLAW_IU_USAGE_LOG = sink;
    await recordIuUsage({
      tool: "test_tool",
      model: "test-model",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 0,
        totalTokens: 120,
        cacheReadTokens: 40,
        costUsd: 0.001,
      },
      latencyMs: 42,
    });
    const row = await readLastRow(sink);
    expect(row.cache_read_tokens).toBe(40);
    expect(row.cache_write_tokens).toBe(0);
    expect(row.cost_usd).toBe(0.001);
    expect(row.outcome).toBe("ok");
    await rm(sink, { force: true });
  });

  test("explicit cacheReadTokens/cacheWriteTokens/costUsd/outcome override usage-derived values", async () => {
    const sink = uniqueSink();
    process.env.SIDECLAW_IU_USAGE_LOG = sink;
    await recordIuUsage({
      tool: "review_ocr",
      model: "deepseek-v4.1-flash",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        totalTokens: 15,
        cacheReadTokens: 999,
        costUsd: 5,
      },
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
      costUsd: null,
      outcome: "error",
      latencyMs: 1,
    });
    const row = await readLastRow(sink);
    expect(row.cache_read_tokens).toBe(7);
    expect(row.cache_write_tokens).toBe(3);
    expect(row.cost_usd).toBeNull();
    expect(row.outcome).toBe("error");
    await rm(sink, { force: true });
  });

  test("no usage at all still writes a well-formed zeroed row", async () => {
    const sink = uniqueSink();
    process.env.SIDECLAW_IU_USAGE_LOG = sink;
    await recordIuUsage({ tool: "test_tool", model: "test-model", latencyMs: 1 });
    const row = await readLastRow(sink);
    expect(row.input_tokens).toBe(0);
    expect(row.cache_read_tokens).toBe(0);
    expect(row.cache_write_tokens).toBe(0);
    expect(row.cost_usd).toBeNull();
    expect(row.outcome).toBe("ok");
    await rm(sink, { force: true });
  });
});

describe("textComplete — empty-text failure path", () => {
  test("records usage with outcome: error before throwing, not silently dropping the spend", async () => {
    const sink = uniqueSink();
    process.env.SIDECLAW_IU_USAGE_LOG = sink;
    stubFetch(sseResponse(""));
    await expect(textComplete({ prompt: "hello", model: "gpt-5.6-terra" })).rejects.toThrow(
      "Text completion returned no content.",
    );
    const row = await readLastRow(sink);
    expect(row.outcome).toBe("error");
    expect(row.tool).toBe("text_complete");
    await rm(sink, { force: true });
  });
});

describe("visionRead — empty-text failure path", () => {
  test("records usage with outcome: error before throwing", async () => {
    const sink = uniqueSink();
    process.env.SIDECLAW_IU_USAGE_LOG = sink;
    stubFetch(sseResponse(""));
    await expect(
      visionRead({ imageBase64: "Zm9v", prompt: "describe this", model: "gemini-3.5-flash" }),
    ).rejects.toThrow("Vision call returned no content.");
    const row = await readLastRow(sink);
    expect(row.outcome).toBe("error");
    expect(row.tool).toBe("read_image");
    await rm(sink, { force: true });
  });
});
