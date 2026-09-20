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
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SIDECLAW_IU_USAGE_LOG = join(tmpdir(), `sideclaw-iu-openai-test-${Date.now()}.jsonl`);
process.env.IU_API_KEY = "test-key";
process.env.IU_BASE_URL = "https://iu.example.com/anthropic";

const { textComplete, visionRead } = await import("../server/lib/iu-openai.ts");

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
});

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
