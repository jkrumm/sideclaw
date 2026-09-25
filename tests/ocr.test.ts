// `server/lib/ocr.ts`'s pure helpers — the mode-args derivation and the block renderer.
// `runOcrReview` itself spawns the real `ocr` binary and is not exercised here, same
// reasoning `tests/routing.test.ts` and `tests/review-scope.test.ts` apply to their own
// process-spawning callers.

import { describe, expect, test } from "bun:test";
import {
  OCR_EFFORT,
  ocrArgs,
  ocrModeArgs,
  ocrProtocolFor,
  ocrSessionSlug,
  ocrSummaryToUsage,
  ocrTransportFor,
  renderOcrBlock,
  sumOcrSessionUsage,
  type OcrProtocol,
  type OcrResult,
  type OcrSummary,
} from "../server/lib/ocr.ts";
import { routeFor } from "../server/lib/routing.ts";

describe("ocrModeArgs", () => {
  test("uncommitted → workspace mode (no flags)", () => {
    expect(ocrModeArgs("uncommitted")).toEqual([]);
  });

  test("head → single-commit mode", () => {
    expect(ocrModeArgs("head")).toEqual(["--commit", "HEAD"]);
  });

  test("a two-dot range → merge-base mode with both sides", () => {
    expect(ocrModeArgs("main..HEAD")).toEqual(["--from", "main", "--to", "HEAD"]);
  });

  test("a three-dot range → merge-base mode with both sides", () => {
    expect(ocrModeArgs("main...feature")).toEqual(["--from", "main", "--to", "feature"]);
  });

  test("a bare ref → merge-base mode against HEAD", () => {
    expect(ocrModeArgs("HEAD~3")).toEqual(["--from", "HEAD~3", "--to", "HEAD"]);
  });

  test("a path-shaped scope (leading slash) → no OCR mode", () => {
    expect(ocrModeArgs("/abs/path/file.ts")).toBeNull();
  });

  test("a path-shaped scope (contains a dot) → no OCR mode", () => {
    expect(ocrModeArgs("server/index.ts")).toBeNull();
  });

  test("refBaseOid always wins over scope, regardless of its shape", () => {
    expect(ocrModeArgs("uncommitted", "abc123")).toEqual(["--from", "abc123", "--to", "HEAD"]);
    expect(ocrModeArgs("pr:5", "abc123")).toEqual(["--from", "abc123", "--to", "HEAD"]);
    expect(ocrModeArgs("server/index.ts", "abc123")).toEqual(["--from", "abc123", "--to", "HEAD"]);
  });
});

describe("renderOcrBlock", () => {
  test("skipped status → a one-line no-comments block", () => {
    const result: OcrResult = { status: "skipped", llm: { model: "x" }, comments: [] };
    expect(renderOcrBlock(result)).toBe("OpenCodeReview: no comments — status skipped.");
  });

  test("skipped with a message → the message is included", () => {
    const result: OcrResult = {
      status: "skipped",
      llm: { model: "x" },
      comments: [],
      message: "no diff to review",
    };
    expect(renderOcrBlock(result)).toBe(
      "OpenCodeReview: no comments — status skipped (no diff to review).",
    );
  });

  test("complete with zero comments → still a one-line no-comments block", () => {
    const result: OcrResult = {
      status: "complete",
      llm: { model: "claude-opus-4-6" },
      comments: [],
    };
    expect(renderOcrBlock(result)).toBe("OpenCodeReview: no comments — status complete.");
  });

  test("complete with comments → header + one line per comment, single-line range", () => {
    const result: OcrResult = {
      status: "complete",
      llm: { model: "claude-opus-4-6" },
      summary: {
        files_reviewed: 3,
        comments: 1,
        total_tokens: 1000,
        input_tokens: 900,
        output_tokens: 100,
        elapsed: "2m51s",
      },
      comments: [
        { path: "server/foo.ts", content: "off-by-one here", start_line: 10, end_line: 10 },
      ],
    };
    const block = renderOcrBlock(result);
    expect(block).toContain("OpenCodeReview — model claude-opus-4-6");
    expect(block).toContain("3 file(s) reviewed, 1 comment(s), 2m51s elapsed");
    expect(block).toContain("- server/foo.ts:10 — off-by-one here");
  });

  test("a multi-line range renders as start-end", () => {
    const result: OcrResult = {
      status: "complete",
      llm: { model: "x" },
      comments: [{ path: "a.ts", content: "msg", start_line: 5, end_line: 8 }],
    };
    expect(renderOcrBlock(result)).toContain("- a.ts:5-8 — msg");
  });

  test("a suggestion_code is appended and truncated past 300 chars", () => {
    const long = "x".repeat(400);
    const result: OcrResult = {
      status: "complete",
      llm: { model: "x" },
      comments: [
        { path: "a.ts", content: "msg", start_line: 1, end_line: 1, suggestion_code: long },
      ],
    };
    const block = renderOcrBlock(result);
    expect(block).toContain("suggestion: " + "x".repeat(300) + "…");
    expect(block).not.toContain("x".repeat(301) + "…");
  });

  test("a short suggestion_code is not truncated", () => {
    const result: OcrResult = {
      status: "complete",
      llm: { model: "x" },
      comments: [
        { path: "a.ts", content: "msg", start_line: 1, end_line: 1, suggestion_code: "short fix" },
      ],
    };
    expect(renderOcrBlock(result)).toContain("suggestion: short fix");
  });

  test("thinking is never rendered even when present", () => {
    const result: OcrResult = {
      status: "complete",
      llm: { model: "x" },
      comments: [
        {
          path: "a.ts",
          content: "msg",
          start_line: 1,
          end_line: 1,
          thinking: "internal reasoning that must not leak",
        },
      ],
    };
    expect(renderOcrBlock(result)).not.toContain("internal reasoning");
  });

  test("warnings are appended when present", () => {
    const result: OcrResult = {
      status: "completed_with_warnings",
      llm: { model: "x" },
      comments: [{ path: "a.ts", content: "msg", start_line: 1, end_line: 1 }],
      warnings: ["one file timed out"],
    };
    const block = renderOcrBlock(result);
    expect(block).toContain("Warnings:");
    expect(block).toContain("- one file timed out");
  });

  test("object-shaped warnings are rendered as JSON", () => {
    const block = renderOcrBlock({
      status: "completed_with_warnings",
      llm: { model: "DeepSeek-V4-Flash" },
      comments: [{ path: "a.ts", content: "x", start_line: 1, end_line: 1 }],
      warnings: [{ file: "b.ts", error: "timeout" }],
    });
    expect(block).toContain('- {"file":"b.ts","error":"timeout"}');
  });

  test("no warnings block when warnings is null or empty", () => {
    const base: OcrResult = {
      status: "complete",
      llm: { model: "x" },
      comments: [{ path: "a.ts", content: "msg", start_line: 1, end_line: 1 }],
    };
    expect(renderOcrBlock({ ...base, warnings: null })).not.toContain("Warnings:");
    expect(renderOcrBlock({ ...base, warnings: [] })).not.toContain("Warnings:");
  });

  test("a null comments field (Go nil slice) is tolerated as zero comments", () => {
    const result = { status: "complete", llm: { model: "x" }, comments: null } as OcrResult;
    expect(renderOcrBlock(result)).toBe("OpenCodeReview: no comments — status complete.");
  });

  test("a missing comments field is tolerated as zero comments", () => {
    const result = { status: "complete", llm: { model: "x" } } as OcrResult;
    expect(renderOcrBlock(result)).toBe("OpenCodeReview: no comments — status complete.");
  });

  test("a missing llm renders 'unknown' instead of throwing", () => {
    const result: OcrResult = {
      status: "complete",
      comments: [{ path: "a.ts", content: "msg", start_line: 1, end_line: 1 }],
    };
    expect(renderOcrBlock(result)).toContain("OpenCodeReview — model unknown");
  });

  test("zero comments with a non-complete/success status and warnings still surfaces both — not a bare 'nothing found'", () => {
    const result: OcrResult = {
      status: "completed_with_errors",
      llm: { model: "x" },
      comments: [],
      warnings: ["3 of 12 files failed to review"],
    };
    const block = renderOcrBlock(result);
    expect(block).toContain("status completed_with_errors");
    expect(block).toContain("Warnings:");
    expect(block).toContain("- 3 of 12 files failed to review");
  });
});

describe("renderOcrBlock caps and status", () => {
  test("a non-complete status shows in the header; long content is truncated", () => {
    const block = renderOcrBlock({
      status: "completed_with_warnings",
      llm: { model: "m" },
      comments: [{ path: "a.ts", content: "x".repeat(5_000), start_line: 1, end_line: 1 }],
    });
    expect(block).toContain("status completed_with_warnings");
    expect(block.length).toBeLessThan(2_000);
    expect(block).toContain("…");
  });

  test("complete status is not repeated in the header", () => {
    const block = renderOcrBlock({
      status: "complete",
      llm: { model: "m" },
      comments: [{ path: "a.ts", content: "c", start_line: 1, end_line: 1 }],
    });
    expect(block).not.toContain("status complete");
  });
});

describe("ocrProtocolFor / ocrTransportFor", () => {
  test.each([
    ["gpt-5.6-luna", "openai-responses"],
    ["GPT-5.6-luna", "openai-responses"],
    ["DeepSeek-V4-Flash", "anthropic"],
    ["claude-haiku-4-5", "anthropic"],
    ["minimax-m3", "anthropic"],
    ["deepseek-v4.1-flash", "openai"],
    ["gemini-3.8-flash", "openai"],
    ["some-unknown-model", "openai"],
  ])("%s → %s", (model, protocol) => {
    expect(ocrProtocolFor(model)).toBe(protocol as OcrProtocol);
  });

  test("the default route resolves to OpenAI chat on the OpenAI base", () => {
    const iu = { anthropicBase: "https://x/anthropic", openaiBase: "https://x/openai/v1" };
    expect(ocrTransportFor(routeFor("review_ocr").model, iu)).toEqual({
      protocol: "openai",
      url: "https://x/openai/v1",
    });
    expect(ocrTransportFor("DeepSeek-V4-Flash", iu).url).toBe("https://x/anthropic");
  });
});

describe("ocrSessionSlug", () => {
  test("turns every path separator into a dash and drops the leading one", () => {
    expect(ocrSessionSlug("/Users/jkrumm/SourceRoot/sideclaw")).toBe(
      "Users-jkrumm-SourceRoot-sideclaw",
    );
  });

  test("a worktree path slugs the same way", () => {
    expect(ocrSessionSlug("/tmp/sideclaw-worktrees/abc123")).toBe("tmp-sideclaw-worktrees-abc123");
  });
});

describe("sumOcrSessionUsage", () => {
  test("sums prompt/completion/cache tokens across every llm_response line", () => {
    const lines = [
      JSON.stringify({ type: "session_start", timestamp: 1000, cwd: "/repo" }),
      JSON.stringify({
        type: "llm_response",
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          cache_read_tokens: 30,
          cache_write_tokens: 5,
        },
      }),
      JSON.stringify({
        type: "llm_response",
        usage: {
          prompt_tokens: 200,
          completion_tokens: 40,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      }),
    ];
    const sum = sumOcrSessionUsage(lines);
    expect(sum.inputTokens).toBe(300);
    expect(sum.outputTokens).toBe(60);
    expect(sum.cacheReadTokens).toBe(30);
    expect(sum.cacheWriteTokens).toBe(5);
    expect(sum.totalTokens).toBe(360);
  });

  test("ignores non-llm_response lines, blank lines, and unparseable JSON", () => {
    const lines = [
      "",
      "   ",
      "not json at all {",
      JSON.stringify({ type: "session_start", timestamp: 1000, cwd: "/repo" }),
      JSON.stringify({ type: "tool_call", name: "bash" }),
      JSON.stringify({ type: "llm_response", usage: { prompt_tokens: 10, completion_tokens: 2 } }),
    ];
    const sum = sumOcrSessionUsage(lines);
    expect(sum.inputTokens).toBe(10);
    expect(sum.outputTokens).toBe(2);
    expect(sum.cacheReadTokens).toBe(0);
    expect(sum.cacheWriteTokens).toBe(0);
  });

  test("an llm_response line with no usage field contributes zero, not a throw", () => {
    const lines = [JSON.stringify({ type: "llm_response" })];
    expect(() => sumOcrSessionUsage(lines)).not.toThrow();
    expect(sumOcrSessionUsage(lines)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    });
  });

  test("an empty line array sums to all zeros", () => {
    expect(sumOcrSessionUsage([])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    });
  });
});

describe("ocrSummaryToUsage", () => {
  test("maps input/output/total straight through, cache_read_tokens onto both places, no cost", () => {
    const summary: OcrSummary = {
      files_reviewed: 3,
      comments: 2,
      total_tokens: 1200,
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 300,
      cache_write_tokens: 50,
      elapsed: "1m2s",
    };
    const result = ocrSummaryToUsage(summary);
    expect(result.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 0,
      totalTokens: 1200,
      cacheReadTokens: 300,
      costUsd: null,
    });
    expect(result.cacheReadTokens).toBe(300);
    expect(result.cacheWriteTokens).toBe(50);
    expect(result.costUsd).toBeNull();
  });

  test("an undefined summary maps to an all-zero usage, never a throw", () => {
    const result = ocrSummaryToUsage(undefined);
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      costUsd: null,
    });
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheWriteTokens).toBe(0);
  });

  test("a summary with no cache fields at all defaults both to 0", () => {
    const summary: OcrSummary = {
      files_reviewed: 1,
      comments: 0,
      total_tokens: 100,
      input_tokens: 90,
      output_tokens: 10,
      elapsed: "5s",
    };
    const result = ocrSummaryToUsage(summary);
    expect(result.usage.cacheReadTokens).toBe(0);
    expect(result.cacheWriteTokens).toBe(0);
  });
});

describe("ocrArgs", () => {
  test("pins no per-subtask timeout and the measured review-pass effort", () => {
    const args = ocrArgs({ modeArgs: ["--commit", "HEAD"], repo: "/r", outFile: "/o.json" });
    expect(args.slice(0, 3)).toEqual(["review", "--commit", "HEAD"]);
    expect(args[args.indexOf("--timeout") + 1]).toBe("0");
    expect(args[args.indexOf("--effort") + 1]).toBe(OCR_EFFORT);
    expect(OCR_EFFORT).toBe("low");
    expect(args).not.toContain("--background-file");
  });

  test("appends the background file when context is given", () => {
    const args = ocrArgs({ modeArgs: [], repo: "/r", outFile: "/o", bgFile: "/bg.md" });
    expect(args.slice(-2)).toEqual(["--background-file", "/bg.md"]);
  });
});
