// Pure boundary logic behind job_wait's `maxWaitMs` input (server/mcp/tools/jobs.ts). The
// ceiling moved from 55 s to 29 min in the same change that raised the MCP client's own
// timeout — this pins the clamp so a regression shows up here, not as a live 30-minute hang.

import { describe, expect, test } from "bun:test";
import { clampMaxWaitMs, DEFAULT_WAIT_MS, MAX_WAIT_MS } from "../server/mcp/tools/jobs.ts";

describe("clampMaxWaitMs", () => {
  test("missing input falls back to the default", () => {
    expect(clampMaxWaitMs(undefined)).toBe(DEFAULT_WAIT_MS);
  });

  test("floors at 1000 ms — a sub-second budget would thrash the poll loop for nothing", () => {
    expect(clampMaxWaitMs(0)).toBe(1000);
    expect(clampMaxWaitMs(1)).toBe(1000);
    expect(clampMaxWaitMs(999)).toBe(1000);
    expect(clampMaxWaitMs(1000)).toBe(1000);
  });

  test("ceils at MAX_WAIT_MS", () => {
    expect(clampMaxWaitMs(MAX_WAIT_MS)).toBe(MAX_WAIT_MS);
    expect(clampMaxWaitMs(MAX_WAIT_MS + 1)).toBe(MAX_WAIT_MS);
    expect(clampMaxWaitMs(60 * 60 * 1000)).toBe(MAX_WAIT_MS);
  });

  test("passes an in-range value through unchanged", () => {
    expect(clampMaxWaitMs(120_000)).toBe(120_000);
  });
});
