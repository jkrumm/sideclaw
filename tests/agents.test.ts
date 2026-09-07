// Bounds of the read-only agent overview (server/lib/agents.ts): the transcript directory
// encoding, tail parsing over synthetic transcript lines, state derivation for every branch
// (including the stale-threshold boundary), merge dedup by sessionId, project sort order, the
// plain-text renderer's line-length cap and trailing newline, and the transcript-tail reader's
// progressive retry (and that it never falls back to file mtime).
//
// No subprocess, no mocks — the one file-touching suite (readTranscriptTailFile) writes a real
// temp file rather than stubbing fs/Bun.file, per repo convention.

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  deriveState,
  encodeProjectDir,
  mergeAgents,
  parseTranscriptTail,
  readTranscriptTailFile,
  renderText,
  stripAnsi,
  type AgentEnrichment,
  type AgentsSnapshot,
  type ClaudeAgentRaw,
  type RenderTextOptions,
  type DispatchJobRaw,
  type HerdrAgentRaw,
  type HerdrWorkspaceRaw,
  type TranscriptTail,
} from "../server/lib/agents.ts";

// ── encodeProjectDir ─────────────────────────────────────────────────────────────────────────

describe("encodeProjectDir", () => {
  test("replaces every non-alphanumeric character with a dash", () => {
    expect(encodeProjectDir("/Users/jkrumm/SourceRoot/dotfiles")).toBe(
      "-Users-jkrumm-SourceRoot-dotfiles",
    );
  });

  test("encodes dots (repo names with a dot, e.g. IuRoot checkouts)", () => {
    expect(encodeProjectDir("/Users/jkrumm/IuRoot/epos_fe.booking")).toBe(
      "-Users-jkrumm-IuRoot-epos-fe-booking",
    );
  });

  test("encodes underscores identically to dots and slashes", () => {
    expect(encodeProjectDir("a_b.c/d")).toBe("a-b-c-d");
  });

  test("leaves alphanumerics untouched", () => {
    expect(encodeProjectDir("abcXYZ019")).toBe("abcXYZ019");
  });
});

// ── parseTranscriptTail ──────────────────────────────────────────────────────────────────────

function assistantLine(text: string, timestamp: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    cwd: "/Users/jkrumm/SourceRoot/dotfiles",
    gitBranch: "master",
    version: "2.1.261",
    message: { content: [{ type: "text", text }] },
  });
}

describe("parseTranscriptTail", () => {
  const fixture = [
    '{"type":"partial-line-should-be-dropped-by-caller-not-us"', // simulates a partial first line
    JSON.stringify({ type: "last-prompt", lastPrompt: "first prompt", sessionId: "s1" }),
    JSON.stringify({ type: "ai-title", aiTitle: "first title", sessionId: "s1" }),
    assistantLine("first reply", "2026-09-01T00:00:00.000Z"),
    "not json at all — garbage line",
    JSON.stringify({
      type: "user",
      timestamp: "2026-09-02T00:00:00.000Z",
      message: { content: [{ tool_use_id: "t1", type: "tool_result", content: "ok" }] },
    }),
    assistantLine("", "2026-09-03T00:00:00.000Z"), // empty text block — ignored for lastReply
    JSON.stringify({ type: "last-prompt", lastPrompt: "second prompt", sessionId: "s1" }),
    JSON.stringify({ type: "ai-title", aiTitle: "second title", sessionId: "s1" }),
    assistantLine("second reply", "2026-09-04T00:00:00.000Z"),
  ].join("\n");

  test("picks the LAST last-prompt / ai-title line, ignoring garbage and unparseable lines", () => {
    const tail = parseTranscriptTail(fixture);
    expect(tail.lastPrompt).toBe("second prompt");
    expect(tail.aiTitle).toBe("second title");
  });

  test("lastReply is the last non-empty assistant text block", () => {
    const tail = parseTranscriptTail(fixture);
    expect(tail.lastReply).toBe("second reply");
  });

  test("lastActivityAt is the last assistant/user timestamp seen, not necessarily an assistant line", () => {
    const tail = parseTranscriptTail(fixture);
    expect(tail.lastActivityAt).toBe(Date.parse("2026-09-04T00:00:00.000Z"));
  });

  test("a garbage-only / empty transcript yields all nulls, never throws", () => {
    const tail = parseTranscriptTail("not json\n\n{broken");
    expect(tail).toEqual({
      lastPrompt: null,
      aiTitle: null,
      lastReply: null,
      lastActivityAt: null,
    });
  });

  test("lastReply is capped at 800 chars", () => {
    const long = "x".repeat(900);
    const tail = parseTranscriptTail(assistantLine(long, "2026-09-01T00:00:00.000Z"));
    expect(tail.lastReply?.length).toBe(800);
  });

  test("a multi-block assistant message picks the last non-empty text block within it", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-01T00:00:00.000Z",
      message: {
        content: [
          { type: "text", text: "first block" },
          { type: "tool_use", name: "Read", input: {} },
          { type: "text", text: "last block" },
        ],
      },
    });
    expect(parseTranscriptTail(line).lastReply).toBe("last block");
  });
});

// ── readTranscriptTailFile (progressive tail, no mtime) ─────────────────────────────────────

describe("readTranscriptTailFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sideclaw-agents-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a first-pass 512 KB window landing inside an oversized trailing line retries wider and finds the earlier timestamp", async () => {
    const path = join(dir, "session.jsonl");
    const oldTimestamp = "2020-01-01T00:00:00.000Z";
    const oldLine = assistantLine("an old reply", oldTimestamp);
    // A 700 KB single line with no trailing newline: bigger than the first-pass 512 KB window,
    // so that pass lands entirely inside it (no complete line, no timestamp) and must retry at
    // 4x (2 MB), which comfortably covers the whole file and reaches `oldLine`.
    const oversizedTrailingLine = "x".repeat(700 * 1024);
    writeFileSync(path, `${oldLine}\n${oversizedTrailingLine}`);

    const tail = await readTranscriptTailFile(path);
    expect(tail.lastActivityAt).toBe(Date.parse(oldTimestamp));
  });

  test("file mtime is never consulted — a bumped mtime does not override the parsed timestamp", async () => {
    const path = join(dir, "session.jsonl");
    const oldTimestamp = "2026-09-04T06:26:00.000Z";
    writeFileSync(path, `${assistantLine("still here", oldTimestamp)}\n`);
    const future = new Date();
    utimesSync(path, future, future); // bump mtime to "now", well after oldTimestamp

    const tail = await readTranscriptTailFile(path);
    expect(tail.lastActivityAt).toBe(Date.parse(oldTimestamp));
  });

  test("a missing file yields the all-null tail, never throws", async () => {
    const tail = await readTranscriptTailFile(join(dir, "does-not-exist.jsonl"));
    expect(tail).toEqual({
      lastPrompt: null,
      aiTitle: null,
      lastReply: null,
      lastActivityAt: null,
    });
  });
});

// ── deriveState ──────────────────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-06T12:00:00.000Z");

describe("deriveState", () => {
  test("herdr blocked → needs_you, regardless of anything else", () => {
    expect(
      deriveState({
        herdrStatus: "blocked",
        claudeStatus: "busy",
        lastActivityAt: null,
        now: NOW,
        staleAfterMs: 24 * HOUR_MS,
        source: "herdr",
        jobStatus: null,
      }),
    ).toBe("needs_you");
  });

  test("claude waiting → needs_you", () => {
    expect(
      deriveState({
        herdrStatus: null,
        claudeStatus: "waiting",
        lastActivityAt: null,
        now: NOW,
        staleAfterMs: 24 * HOUR_MS,
        source: "claude",
        jobStatus: null,
      }),
    ).toBe("needs_you");
  });

  test("herdr working → working", () => {
    expect(
      deriveState({
        herdrStatus: "working",
        claudeStatus: null,
        lastActivityAt: null,
        now: NOW,
        staleAfterMs: 24 * HOUR_MS,
        source: "herdr",
        jobStatus: null,
      }),
    ).toBe("working");
  });

  test("claude busy → working", () => {
    expect(
      deriveState({
        herdrStatus: null,
        claudeStatus: "busy",
        lastActivityAt: null,
        now: NOW,
        staleAfterMs: 24 * HOUR_MS,
        source: "claude",
        jobStatus: null,
      }),
    ).toBe("working");
  });

  test("dispatch running → working", () => {
    expect(
      deriveState({
        herdrStatus: null,
        claudeStatus: null,
        lastActivityAt: null,
        now: NOW,
        staleAfterMs: 24 * HOUR_MS,
        source: "dispatch",
        jobStatus: "running",
      }),
    ).toBe("working");
  });

  test("dispatch pending (queued) → working", () => {
    expect(
      deriveState({
        herdrStatus: null,
        claudeStatus: null,
        lastActivityAt: null,
        now: NOW,
        staleAfterMs: 24 * HOUR_MS,
        source: "dispatch",
        jobStatus: "pending",
      }),
    ).toBe("working");
  });

  test("herdr idle, activity exactly at the stale threshold → NOT stale (boundary is exclusive)", () => {
    const staleAfterMs = 24 * HOUR_MS;
    expect(
      deriveState({
        herdrStatus: "idle",
        claudeStatus: null,
        lastActivityAt: NOW - staleAfterMs,
        now: NOW,
        staleAfterMs,
        source: "herdr",
        jobStatus: null,
      }),
    ).toBe("idle");
  });

  test("herdr idle, activity 1ms past the stale threshold → stale", () => {
    const staleAfterMs = 24 * HOUR_MS;
    expect(
      deriveState({
        herdrStatus: "idle",
        claudeStatus: null,
        lastActivityAt: NOW - staleAfterMs - 1,
        now: NOW,
        staleAfterMs,
        source: "herdr",
        jobStatus: null,
      }),
    ).toBe("stale");
  });

  test("herdr done, stale-old → stale (done is stale-eligible too)", () => {
    const staleAfterMs = 24 * HOUR_MS;
    expect(
      deriveState({
        herdrStatus: "done",
        claudeStatus: null,
        lastActivityAt: NOW - staleAfterMs - HOUR_MS,
        now: NOW,
        staleAfterMs,
        source: "herdr",
        jobStatus: null,
      }),
    ).toBe("stale");
  });

  test("herdr idle, recent activity → idle", () => {
    expect(
      deriveState({
        herdrStatus: "idle",
        claudeStatus: null,
        lastActivityAt: NOW - HOUR_MS,
        now: NOW,
        staleAfterMs: 24 * HOUR_MS,
        source: "herdr",
        jobStatus: null,
      }),
    ).toBe("idle");
  });

  test("herdr idle, no lastActivityAt at all → idle, never stale (nothing to compare)", () => {
    expect(
      deriveState({
        herdrStatus: "idle",
        claudeStatus: null,
        lastActivityAt: null,
        now: NOW,
        staleAfterMs: 24 * HOUR_MS,
        source: "herdr",
        jobStatus: null,
      }),
    ).toBe("idle");
  });

  test("herdr done, recent activity → done", () => {
    expect(
      deriveState({
        herdrStatus: "done",
        claudeStatus: null,
        lastActivityAt: NOW - HOUR_MS,
        now: NOW,
        staleAfterMs: 24 * HOUR_MS,
        source: "herdr",
        jobStatus: null,
      }),
    ).toBe("done");
  });

  test("terminal dispatch job (done/failed/interrupted) → done", () => {
    for (const jobStatus of ["done", "failed", "interrupted"] as const) {
      expect(
        deriveState({
          herdrStatus: null,
          claudeStatus: null,
          lastActivityAt: null,
          now: NOW,
          staleAfterMs: 24 * HOUR_MS,
          source: "dispatch",
          jobStatus,
        }),
      ).toBe("done");
    }
  });

  test("nothing matches any branch → unknown", () => {
    expect(
      deriveState({
        herdrStatus: "unknown",
        claudeStatus: null,
        lastActivityAt: null,
        now: NOW,
        staleAfterMs: 24 * HOUR_MS,
        source: "herdr",
        jobStatus: null,
      }),
    ).toBe("unknown");
  });
});

// ── mergeAgents ──────────────────────────────────────────────────────────────────────────────

function herdrAgent(overrides: Partial<HerdrAgentRaw> = {}): HerdrAgentRaw {
  return {
    agent_session: { value: "session-1" },
    agent_status: "working",
    cwd: "/Users/jkrumm/SourceRoot/dotfiles",
    pane_id: "wR:p4",
    workspace_id: "wR",
    terminal_title_stripped: "Some task",
    ...overrides,
  };
}

function claudeAgent(overrides: Partial<ClaudeAgentRaw> = {}): ClaudeAgentRaw {
  return {
    cwd: "/Users/jkrumm/SourceRoot/dotfiles",
    sessionId: "session-1",
    startedAt: 1000,
    status: "busy",
    ...overrides,
  };
}

const NO_TAIL: TranscriptTail = {
  lastPrompt: null,
  aiTitle: null,
  lastReply: null,
  lastActivityAt: null,
};

describe("mergeAgents", () => {
  test("a herdr pane and a claude registry entry with the same sessionId collapse into one agent, herdr status winning", () => {
    const projects = mergeAgents({
      herdrAgents: [herdrAgent({ agent_status: "idle" })],
      herdrWorkspaces: [{ workspace_id: "wR", label: "dotfiles" }],
      claudeAgents: [claudeAgent({ status: "busy" })],
      dispatchJobs: [],
      transcripts: new Map(),
      now: NOW,
      staleAfterMs: 24 * HOUR_MS,
    });

    expect(projects).toHaveLength(1);
    const agents = projects[0]?.agents ?? [];
    expect(agents).toHaveLength(1);
    // "herdr status wins" is about identity, not the derived state: the merged entry keeps
    // source "herdr" (never flips to "claude") once a herdr pane exists for the sessionId,
    // and both raw statuses are preserved on the merged entry rather than one overwriting
    // the other.
    expect(agents[0]?.source).toBe("herdr");
    expect(agents[0]?.herdrStatus).toBe("idle");
    expect(agents[0]?.claudeStatus).toBe("busy");
    // deriveState's own priority order (working — herdr working OR claude busy) still applies
    // to the merged fields, so claude's "busy" here correctly outranks herdr's "idle".
    expect(agents[0]?.state).toBe("working");
  });

  test("a claude agent with no matching herdr pane becomes its own 'claude'-sourced entry", () => {
    const projects = mergeAgents({
      herdrAgents: [],
      herdrWorkspaces: [],
      claudeAgents: [claudeAgent({ sessionId: "bg-session", status: "idle" })],
      dispatchJobs: [],
      transcripts: new Map(),
      now: NOW,
      staleAfterMs: 24 * HOUR_MS,
    });

    expect(projects).toHaveLength(1);
    expect(projects[0]?.agents[0]?.source).toBe("claude");
    expect(projects[0]?.agents[0]?.sessionId).toBe("bg-session");
  });

  test("project name resolves via the herdr workspace label, not basename(cwd)", () => {
    const projects = mergeAgents({
      herdrAgents: [herdrAgent({ cwd: "/Users/jkrumm/SourceRoot/some-checkout-dir" })],
      herdrWorkspaces: [{ workspace_id: "wR", label: "dotfiles" }],
      claudeAgents: [],
      dispatchJobs: [],
      transcripts: new Map(),
      now: NOW,
      staleAfterMs: 24 * HOUR_MS,
    });
    expect(projects[0]?.name).toBe("dotfiles");
  });

  test("no workspace match falls back to basename(cwd)", () => {
    const projects = mergeAgents({
      herdrAgents: [],
      herdrWorkspaces: [],
      claudeAgents: [claudeAgent({ cwd: "/Users/jkrumm/SourceRoot/meteo" })],
      dispatchJobs: [],
      transcripts: new Map(),
      now: NOW,
      staleAfterMs: 24 * HOUR_MS,
    });
    expect(projects[0]?.name).toBe("meteo");
  });

  test("a dispatch job becomes its own entry, keyed separately from any sessionId", () => {
    const job: DispatchJobRaw = {
      id: "job-1",
      status: "running",
      cwd: "/Users/jkrumm/SourceRoot/vps",
      tier: "implement",
      createdAt: NOW - 1000,
      startedAt: NOW - 500,
      finishedAt: null,
    };
    const projects = mergeAgents({
      herdrAgents: [],
      herdrWorkspaces: [],
      claudeAgents: [],
      dispatchJobs: [job],
      transcripts: new Map(),
      now: NOW,
      staleAfterMs: 24 * HOUR_MS,
    });
    expect(projects).toHaveLength(1);
    const agent = projects[0]?.agents[0];
    expect(agent?.source).toBe("dispatch");
    expect(agent?.id).toBe("job-1");
    expect(agent?.tier).toBe("implement");
    expect(agent?.state).toBe("working");
  });

  test("projects sort most-urgent-first: needs_you > working > idle > stale > done, then by name", () => {
    const stale = herdrAgent({
      agent_session: { value: "s-stale" },
      agent_status: "idle",
      cwd: "/Users/jkrumm/SourceRoot/z-project",
      workspace_id: "wZ",
      pane_id: "wZ:p1",
    });
    const working = herdrAgent({
      agent_session: { value: "s-working" },
      agent_status: "working",
      cwd: "/Users/jkrumm/SourceRoot/a-project",
      workspace_id: "wA",
      pane_id: "wA:p1",
    });
    const needsYou = herdrAgent({
      agent_session: { value: "s-needs-you" },
      agent_status: "blocked",
      cwd: "/Users/jkrumm/SourceRoot/m-project",
      workspace_id: "wM",
      pane_id: "wM:p1",
    });
    const workspaces: HerdrWorkspaceRaw[] = [
      { workspace_id: "wZ", label: "z-project" },
      { workspace_id: "wA", label: "a-project" },
      { workspace_id: "wM", label: "m-project" },
    ];
    const staleAfterMs = 24 * HOUR_MS;
    const transcripts = new Map<string, TranscriptTail>([
      ["s-stale", { ...NO_TAIL, lastActivityAt: NOW - staleAfterMs - HOUR_MS }],
    ]);

    const projects = mergeAgents({
      herdrAgents: [stale, working, needsYou],
      herdrWorkspaces: workspaces,
      claudeAgents: [],
      dispatchJobs: [],
      transcripts,
      now: NOW,
      staleAfterMs,
    });

    expect(projects.map((p) => p.name)).toEqual(["m-project", "a-project", "z-project"]);
  });

  test("projects tie-break by name when urgency rank is equal", () => {
    const b = herdrAgent({
      agent_session: { value: "s-b" },
      agent_status: "working",
      cwd: "/x/b-project",
      workspace_id: "wB",
      pane_id: "wB:p1",
    });
    const a = herdrAgent({
      agent_session: { value: "s-a" },
      agent_status: "working",
      cwd: "/x/a-project",
      workspace_id: "wA",
      pane_id: "wA:p1",
    });
    const projects = mergeAgents({
      herdrAgents: [b, a],
      herdrWorkspaces: [
        { workspace_id: "wB", label: "b-project" },
        { workspace_id: "wA", label: "a-project" },
      ],
      claudeAgents: [],
      dispatchJobs: [],
      transcripts: new Map(),
      now: NOW,
      staleAfterMs: 24 * HOUR_MS,
    });
    expect(projects.map((p) => p.name)).toEqual(["a-project", "b-project"]);
  });
});

// ── renderText ───────────────────────────────────────────────────────────────────────────────

describe("renderText", () => {
  function snapshot(overrides: Partial<AgentsSnapshot> = {}): AgentsSnapshot {
    return {
      generatedAt: NOW,
      staleAfterHours: 24,
      summary: { needsYou: 0, working: 0, idle: 0, stale: 0, done: 0, dispatch: 0 },
      projects: [],
      warnings: [],
      ...overrides,
    };
  }

  test("every line is at most 110 chars, even with a long title", () => {
    const longTitle = "T".repeat(400);
    const data = snapshot({
      summary: { needsYou: 1, working: 0, idle: 0, stale: 0, done: 0, dispatch: 0 },
      projects: [
        {
          name: "some-project",
          cwd: "/x/some-project",
          git: { branch: "master", dirty: true, ahead: 0, behind: 0, lastCommit: null },
          agents: [
            {
              id: "s1",
              source: "herdr",
              sessionId: "s1",
              paneId: "wR:p4",
              workspaceId: "wR",
              title: longTitle,
              state: "needs_you",
              herdrStatus: "blocked",
              claudeStatus: null,
              waitingFor: "a very long waiting reason ".repeat(5),
              tier: null,
              lastPrompt: null,
              lastReply: null,
              lastActivityAt: NOW - 5 * 60_000,
              startedAt: null,
            },
          ],
        },
      ],
    });

    const text = renderText(data);
    for (const line of text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(110);
    }
  });

  test("an untitled agent renders as (untitled)", () => {
    const data = snapshot({
      projects: [
        {
          name: "p",
          cwd: "/x/p",
          git: null,
          agents: [
            {
              id: "s1",
              source: "claude",
              sessionId: "s1",
              paneId: null,
              workspaceId: null,
              title: null,
              state: "idle",
              herdrStatus: null,
              claudeStatus: "idle",
              waitingFor: null,
              tier: null,
              lastPrompt: null,
              lastReply: null,
              lastActivityAt: null,
              startedAt: null,
            },
          ],
        },
      ],
    });
    expect(renderText(data)).toContain("(untitled)");
  });

  test("header line carries the summary counts and no project lines when there are none", () => {
    const text = renderText(snapshot());
    expect(text).toContain("0 needs_you");
    // One header line plus the trailing newline's empty tail element.
    expect(text.split("\n")).toEqual([expect.stringContaining("0 needs_you"), ""]);
  });

  test("output ends with a trailing newline (so it doesn't glue onto the next shell prompt)", () => {
    expect(renderText(snapshot()).endsWith("\n")).toBe(true);
  });
});

// ── renderText — colour (opts.color) ────────────────────────────────────────────────────────

describe("renderText with color", () => {
  function coloredSnapshot(overrides: Partial<AgentsSnapshot> = {}): AgentsSnapshot {
    return {
      generatedAt: NOW,
      staleAfterHours: 24,
      summary: { needsYou: 1, working: 0, idle: 0, stale: 0, done: 0, dispatch: 0 },
      projects: [
        {
          name: "some-project",
          cwd: "/x/some-project",
          git: { branch: "master", dirty: true, ahead: 0, behind: 0, lastCommit: null },
          agents: [
            {
              id: "s1",
              source: "herdr",
              sessionId: "s1",
              paneId: "wR:p4",
              workspaceId: "wR",
              title: "blocked on a question",
              state: "needs_you",
              herdrStatus: "blocked",
              claudeStatus: null,
              waitingFor: "dialog open",
              tier: null,
              lastPrompt: null,
              lastReply: null,
              lastActivityAt: NOW - 5 * 60_000,
              startedAt: null,
            },
          ],
        },
      ],
      warnings: [],
      ...overrides,
    };
  }

  test("plain output is identical with color:false and with no opts at all", () => {
    const data = coloredSnapshot();
    expect(renderText(data, { color: false })).toBe(renderText(data));
  });

  test("a needs_you (answer-equivalent) agent line carries the bold-red SGR", () => {
    const text = renderText(coloredSnapshot(), { color: true });
    const line = text.split("\n").find((l) => l.includes("blocked on a question"));
    expect(line).toBeDefined();
    expect(line).toContain("\x1b[1m\x1b[31m");
  });

  // MUTATION-VERIFIED: dropping the trailing `${RESET}` from a coloured span's line builder
  // (e.g. rendering `${spanColor}${base}` with no reset) turns this red — every line containing
  // an escape byte would no longer end with the reset sequence.
  test("every coloured line resets before the newline", () => {
    const text = renderText(coloredSnapshot(), { color: true });
    for (const line of text.split("\n")) {
      if (line.includes("\x1b[")) {
        expect(line.endsWith("\x1b[0m")).toBe(true);
      }
    }
  });

  test("stripAnsi(coloured) matches the plain render, once the extra summary-bar line is dropped", () => {
    const data = coloredSnapshot();
    const plain = renderText(data);
    const colored = renderText(data, { color: true });
    // Colored mode inserts one extra bar line right after the header (index 1).
    const coloredLines = stripAnsi(colored).split("\n");
    coloredLines.splice(1, 1);
    expect(coloredLines.join("\n")).toBe(plain);
  });

  test("the visible-width clamp still holds when a 200-char waitingFor pushes the line over 110", () => {
    const longWaitingFor = "w".repeat(200);
    const data = coloredSnapshot({
      projects: [
        {
          name: "some-project",
          cwd: "/x/some-project",
          git: { branch: "master", dirty: false, ahead: 0, behind: 0, lastCommit: null },
          agents: [
            {
              id: "s1",
              source: "herdr",
              sessionId: "s1",
              paneId: "wR:p4",
              workspaceId: "wR",
              title: "some task",
              state: "needs_you",
              herdrStatus: "blocked",
              claudeStatus: null,
              waitingFor: longWaitingFor,
              tier: null,
              lastPrompt: null,
              lastReply: null,
              lastActivityAt: NOW - 5 * 60_000,
              startedAt: null,
            },
          ],
        },
      ],
    });
    const text = renderText(data, { color: true });
    for (const line of text.split("\n")) {
      // Every visible-clamped line still ends in a reset once truncated.
      expect(stripAnsi(line).length).toBeLessThanOrEqual(110);
      if (line.includes("\x1b[")) expect(line.endsWith("\x1b[0m")).toBe(true);
    }
  });
});

// ── renderText — narrow terminal (opts.cols) ────────────────────────────────────────────────

describe("renderText with cols", () => {
  // Deliberately over-long everywhere a real terminal could wrap: two agents (one blocked with
  // a long waitingFor, one plain), a long title, a long branch/project name, and — via
  // enrichment — a long standing line. Shared by both narrow-width tests below.
  function bigFixture(): { data: AgentsSnapshot; enrichment: Map<string, AgentEnrichment> } {
    const data: AgentsSnapshot = {
      generatedAt: NOW,
      staleAfterHours: 24,
      summary: { needsYou: 1, working: 1, idle: 0, stale: 0, done: 0, dispatch: 0 },
      warnings: [],
      projects: [
        {
          name: "a-fairly-long-project-name-for-testing",
          cwd: "/x/some-project",
          git: {
            branch: "a-fairly-long-feature-branch-name",
            dirty: true,
            ahead: 0,
            behind: 0,
            lastCommit: null,
          },
          agents: [
            {
              id: "a1",
              source: "herdr",
              sessionId: "a1",
              paneId: "wR:p4",
              workspaceId: "wR",
              title: "T".repeat(200),
              state: "needs_you",
              herdrStatus: "blocked",
              claudeStatus: null,
              waitingFor: "w".repeat(200),
              tier: null,
              lastPrompt: null,
              lastReply: null,
              lastActivityAt: NOW - 5 * 60_000,
              startedAt: null,
            },
            {
              id: "a2",
              source: "claude",
              sessionId: "a2",
              paneId: null,
              workspaceId: null,
              title: "another task in progress",
              state: "working",
              herdrStatus: null,
              claudeStatus: "busy",
              waitingFor: null,
              tier: null,
              lastPrompt: null,
              lastReply: null,
              lastActivityAt: NOW - 60_000,
              startedAt: null,
            },
          ],
        },
      ],
    };
    const enrichment = new Map<string, { recommendation: "answer"; standing: string }>([
      ["a1", { recommendation: "answer", standing: "s".repeat(300) }],
    ]);
    return { data, enrichment };
  }

  function assertWidthHolds(cols: number) {
    const { data, enrichment } = bigFixture();
    const text = renderText(data, { enrichment, overview: { ageMs: 0 }, color: true, cols });
    const lines = text.split("\n");
    for (const line of lines) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(cols);
    }
    // The standing line's truncation must still elide with "…", not get chopped mid-ellipsis
    // by the hard clamp — this is what the `standingMax = cols - 8` offset (not just `cols`)
    // exists for.
    const standingLine = lines.find((l) => l.includes("—"));
    expect(standingLine).toBeDefined();
    expect(stripAnsi(standingLine as string).endsWith("…")).toBe(true);
  }

  test("every line's visible width stays within cols=80 on the big fixture", () => {
    assertWidthHolds(80);
  });

  test("every line's visible width stays within cols=60 on the big fixture", () => {
    assertWidthHolds(60);
  });

  test("title is capped at cols-40 (min 20) — a cols=45 title never grows the line", () => {
    const { data, enrichment } = bigFixture();
    const text = renderText(data, { enrichment, overview: { ageMs: 0 }, cols: 45 });
    const agentLine = text.split("\n").find((l) => l.includes("TTTT"));
    expect(agentLine).toBeDefined();
    // MIN_TITLE_CHARS(20) survives as the truncated title's length (incl. the elided "…").
    expect(agentLine).toContain("T".repeat(19) + "…");
  });

  test("project line drops the agent-count suffix below cols=90", () => {
    const { data, enrichment } = bigFixture();
    const text = renderText(data, { enrichment, overview: { ageMs: 0 }, cols: 80 });
    const projectLine = text.split("\n").find((l) => l.includes("▸"));
    expect(projectLine).toBeDefined();
    expect(projectLine).not.toContain("agents]");
  });

  test("project line keeps the agent-count suffix at cols=90 and above", () => {
    const { data, enrichment } = bigFixture();
    const text = renderText(data, { enrichment, overview: { ageMs: 0 }, cols: 90 });
    const projectLine = text.split("\n").find((l) => l.includes("▸"));
    expect(projectLine).toContain("[2 agents]");
  });

  test("header splits into two lines below cols=100", () => {
    const { data, enrichment } = bigFixture();
    const text = renderText(data, { enrichment, overview: { ageMs: 0 }, cols: 80 });
    const lines = text.split("\n");
    expect(lines[0]).toContain("needs_you");
    expect(lines[0]).not.toContain("overview");
    expect(lines[1]).toContain("overview");
  });

  test("header stays one (unsplit) line once cols is wide enough to hold it whole", () => {
    const { data, enrichment } = bigFixture();
    // Wide enough that the combined counts+timestamp+overview header (~115 chars here) is
    // never truncated — cols=100 alone only guarantees "not split", not "not clamped", since
    // `cols` "replaces the fixed 110 clamp for every line" including the header.
    const text = renderText(data, { enrichment, overview: { ageMs: 0 }, cols: 150 });
    const lines = text.split("\n");
    expect(lines[0]).toContain("needs_you");
    expect(lines[0]).toContain("overview");
    expect(lines.filter((l) => l.includes("overview")).length).toBe(1);
  });

  // MUTATION-VERIFIED: replacing `standingMax = cols - 8` with `cols` (dropping the prefix
  // offset) turns this red — clampVisible's hard cut then lands mid-ellipsis, so the standing
  // line no longer ends with "…".
  test("mutation guard: the standing cap leaves room for the '      — ' prefix", () => {
    assertWidthHolds(80);
    assertWidthHolds(60);
  });

  test("default behaviour (no opts.cols at all) is unaffected by the narrow-width machinery", () => {
    const { data, enrichment } = bigFixture();
    const opts: RenderTextOptions = { enrichment, overview: { ageMs: 0 } };
    const text = renderText(data, opts);
    // Single header line (never split — legacy path), title truncated at the fixed
    // MAX_TITLE_CHARS (48), agent-count suffix kept — all exactly as before `cols` existed.
    const lines = text.split("\n");
    expect(lines[0]).toContain("overview"); // not split into two lines
    expect(lines.filter((l) => l.includes("overview")).length).toBe(1);
    expect(text).toContain("[2 agents]");
    // Header stays exempt from the clamp in this path (documented above) — every OTHER line
    // still respects the fixed 110-char cap.
    for (const line of lines.slice(1)) {
      expect(line.length).toBeLessThanOrEqual(110);
    }
  });
});
