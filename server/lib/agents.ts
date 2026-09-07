import { basename, join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { z } from "zod";
import { appLogger as logger } from "../logger.ts";
import type { JobRecord, JobStatus } from "../jobs/types.ts";
import { listJobRecords } from "../jobs/store.ts";
import { getGitStatus } from "./git.ts";

// One producer, one JSON snapshot, three renderers (Hermes, an Argo dashboard, a brain page,
// a herdr pane). Read-only, no LLM: this module deterministically merges three CLI/registry
// sources by Claude sessionId and derives a single urgency `state` per agent. See
// server/routes/agents.ts for the HTTP surface and CLAUDE.md's `### agents` section for the
// operational summary.

// ── Output schema (single source of truth — zod, per .claude/rules/mcp-tools.md) ───────────

export const AGENT_SOURCE = z.enum(["herdr", "claude", "dispatch"]);
export type AgentSource = z.infer<typeof AGENT_SOURCE>;

export const AGENT_STATE = z.enum(["needs_you", "working", "idle", "stale", "done", "unknown"]);
export type AgentState = z.infer<typeof AGENT_STATE>;

export const HERDR_STATUS = z.enum(["working", "idle", "blocked", "done", "unknown"]);
export type HerdrAgentStatus = z.infer<typeof HERDR_STATUS>;

export const CLAUDE_STATUS = z.enum(["idle", "busy", "waiting"]);
export type ClaudeAgentStatus = z.infer<typeof CLAUDE_STATUS>;

export const DISPATCH_TIER = z.enum(["investigate", "author", "implement"]);
export type DispatchTierName = z.infer<typeof DISPATCH_TIER>;

// ── `overview` job's recommendation enum ────────────────────────────────────────────────────
//
// Lives here (not in jobs/handlers/overview.ts) so the pure `renderText` renderer — this
// module's, not the job's — can map it to an icon without an upward import from lib/ into
// jobs/handlers/. overview.ts imports this instead of redeclaring it.

export const RECOMMENDATION = z.enum([
  "answer", // blocked on a question/dialog/permission — reply to it
  "continue", // idle mid-task with a clear next step — safe to send "continue"
  "ship", // done but uncommitted/unpushed/ahead of origin — commit/push
  "review", // pushed and needs review or human QA before it counts as done
  "merge", // a PR/branch is ready to merge
  "close", // finished, nothing pending — the pane can be closed
  "stale", // abandoned or superseded, no clear next step
  "watch", // actively working, nothing to do — also the safe default when unsure
]);
export type Recommendation = z.infer<typeof RECOMMENDATION>;

export const CONFIDENCE = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof CONFIDENCE>;

export const RECOMMENDATION_ICON: Record<Recommendation, string> = {
  answer: "?!",
  continue: "→",
  ship: "⇧",
  review: "⚑",
  merge: "⇄",
  close: "✓",
  stale: "·",
  watch: "●",
};

export const AGENT_OUTPUT = z.object({
  id: z
    .string()
    .describe(
      "Stable identifier: the Claude sessionId for herdr/claude-sourced agents, the " +
        "sideclaw job id for dispatch-sourced entries.",
    ),
  source: AGENT_SOURCE.describe(
    "Which collector produced this entry: a herdr pane, Claude's own agent registry " +
      "(no herdr pane — usually a `claude --bg` daemon), or a sideclaw dispatch job.",
  ),
  sessionId: z.string().nullable().describe("Claude Code session id. Null for dispatch entries."),
  paneId: z
    .string()
    .nullable()
    .describe("herdr pane id, e.g. 'wR:p4'. Null when there is no herdr pane."),
  workspaceId: z
    .string()
    .nullable()
    .describe("herdr workspace id. Null when there is no herdr pane."),
  title: z
    .string()
    .nullable()
    .describe(
      "herdr's stripped terminal title, falling back to the transcript's ai-title line. " +
        "Null if neither is available.",
    ),
  state: AGENT_STATE.describe(
    "Single derived urgency state — see deriveState()'s doc comment for the priority order.",
  ),
  herdrStatus: HERDR_STATUS.nullable().describe(
    "Raw herdr agent_status. Null when there is no herdr pane.",
  ),
  claudeStatus: CLAUDE_STATUS.nullable().describe(
    "Raw `claude agents --json` status. Null when this session has no entry in Claude's own " +
      "registry (a herdr pane whose CLI process already exited, or a dispatch entry).",
  ),
  waitingFor: z
    .string()
    .nullable()
    .describe(
      "Claude's waitingFor reason (e.g. 'dialog open'). Set only when claudeStatus is 'waiting'.",
    ),
  tier: DISPATCH_TIER.nullable().describe("Dispatch tier. Null for non-dispatch entries."),
  lastPrompt: z
    .string()
    .nullable()
    .describe("The user's latest prompt, from the session transcript tail. Null if unavailable."),
  lastReply: z
    .string()
    .nullable()
    .describe(
      "The last non-empty assistant text block from the transcript tail, trimmed and capped " +
        "at 800 chars. Null if unavailable.",
    ),
  lastActivityAt: z
    .number()
    .nullable()
    .describe(
      "Epoch ms of the last observed activity — for herdr/claude entries, the transcript " +
        "tail's last parsed line timestamp (read progressively: 512 KB, growing to 8 MB when " +
        "the tail lands inside an oversized line; file mtime is never used — Claude Code " +
        "touches an idle session's transcript file, so mtime does not mean user activity); " +
        "job timestamp for dispatch entries. Null if unknown.",
    ),
  startedAt: z
    .number()
    .nullable()
    .describe(
      "Epoch ms the process/job started, from `claude agents --json` or the dispatch job " +
        "record. Null for herdr-only entries (herdr does not report a start time).",
    ),
});
export type Agent = z.infer<typeof AGENT_OUTPUT>;

export const GIT_COMMIT_OUTPUT = z.object({
  sha: z.string().describe("Abbreviated commit sha (%h)."),
  subject: z.string().describe("Commit subject line."),
  at: z.string().describe("ISO 8601 committer date (%cI)."),
});

export const PROJECT_GIT_OUTPUT = z.object({
  branch: z.string().describe("Current branch name."),
  dirty: z.boolean().describe("True when `git status --porcelain` reports any changed files."),
  ahead: z.number().describe("Commits ahead of the upstream tracking branch."),
  behind: z.number().describe("Commits behind the upstream tracking branch."),
  lastCommit: GIT_COMMIT_OUTPUT.nullable().describe(
    "Most recent commit reachable from HEAD. Null when the repo has no commits on the branch.",
  ),
});
export type ProjectGit = z.infer<typeof PROJECT_GIT_OUTPUT>;

export const PROJECT_OUTPUT = z.object({
  name: z
    .string()
    .describe(
      "Project name: the herdr workspace label when a pane resolves it, else the cwd's basename.",
    ),
  cwd: z.string().describe("Absolute path used to resolve git status for this project."),
  git: PROJECT_GIT_OUTPUT.nullable().describe(
    "Git status for cwd. Null when getGitStatus() failed (not a git repo, or the git " +
      "invocation errored/timed out).",
  ),
  agents: z.array(AGENT_OUTPUT).describe("Every agent grouped under this project."),
});
export type Project = z.infer<typeof PROJECT_OUTPUT>;

export const AGENTS_SUMMARY_OUTPUT = z.object({
  needsYou: z.number().describe("Agents in state needs_you, across all projects."),
  working: z.number().describe("Agents in state working."),
  idle: z.number().describe("Agents in state idle."),
  stale: z.number().describe("Agents in state stale."),
  done: z.number().describe("Agents in state done."),
  dispatch: z.number().describe("Dispatch-sourced entries included in this snapshot."),
});
export type AgentsSummary = z.infer<typeof AGENTS_SUMMARY_OUTPUT>;

export const AGENTS_SNAPSHOT_OUTPUT = z.object({
  generatedAt: z.number().describe("Epoch ms this snapshot was produced."),
  staleAfterHours: z
    .number()
    .describe("Threshold (SIDECLAW_AGENT_STALE_HOURS, default 24) used to derive state stale."),
  summary: AGENTS_SUMMARY_OUTPUT,
  projects: z
    .array(PROJECT_OUTPUT)
    .describe("Sorted most-urgent-first: needs_you > working > idle > stale > done, then by name."),
  warnings: z
    .array(z.string())
    .describe("Non-fatal collector failures, e.g. a herdr or claude CLI call failed or timed out."),
});
export type AgentsSnapshot = z.infer<typeof AGENTS_SNAPSHOT_OUTPUT>;

// ── Pure: cwd → transcript directory encoding ───────────────────────────────────────────────

/**
 * `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl` — encoded cwd is the absolute path with
 * every character that is not `[A-Za-z0-9]` replaced by `-`.
 * e.g. "/Users/jkrumm/IuRoot/epos_fe.booking" → "-Users-jkrumm-IuRoot-epos-fe-booking".
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

// ── Pure: transcript tail parsing ───────────────────────────────────────────────────────────

export interface TranscriptTail {
  lastPrompt: string | null;
  aiTitle: string | null;
  lastReply: string | null;
  /** Epoch ms of the last assistant/user line's timestamp. */
  lastActivityAt: number | null;
}

const EMPTY_TAIL: TranscriptTail = {
  lastPrompt: null,
  aiTitle: null,
  lastReply: null,
  lastActivityAt: null,
};

// Raised 400 → 800 for the `overview` job's prompt, which quotes lastReply as context for
// the LLM recommendation — the API field cap stays in lockstep (see AGENT_OUTPUT above) so
// there's one source of truth, not a second cap that could drift from this one.
const MAX_REPLY_CHARS = 800;

/**
 * Parses the tail of a session's `.jsonl` transcript (already truncated to the last N bytes
 * by the caller, with any leading partial line already dropped). Ignores lines that don't
 * parse as JSON and line types it doesn't recognize — the transcript carries many more line
 * types than the four this cares about.
 */
export function parseTranscriptTail(text: string): TranscriptTail {
  let lastPrompt: string | null = null;
  let aiTitle: string | null = null;
  let lastReply: string | null = null;
  let lastActivityAt: number | null = null;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = record.type;

    if (type === "last-prompt" && typeof record.lastPrompt === "string") {
      lastPrompt = record.lastPrompt;
      continue;
    }
    if (type === "ai-title" && typeof record.aiTitle === "string") {
      aiTitle = record.aiTitle;
      continue;
    }
    if (type !== "assistant" && type !== "user") continue;

    if (typeof record.timestamp === "string") {
      const ms = Date.parse(record.timestamp);
      if (!Number.isNaN(ms)) lastActivityAt = ms;
    }

    if (type !== "assistant") continue;
    const message = record.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "text" || typeof b.text !== "string") continue;
      const trimmedText = b.text.trim();
      if (trimmedText) lastReply = trimmedText.slice(0, MAX_REPLY_CHARS);
    }
  }

  return { lastPrompt, aiTitle, lastReply, lastActivityAt };
}

// ── Pure: state derivation ───────────────────────────────────────────────────────────────────

export interface DeriveStateInput {
  herdrStatus: HerdrAgentStatus | null;
  claudeStatus: ClaudeAgentStatus | null;
  lastActivityAt: number | null;
  now: number;
  staleAfterMs: number;
  source: AgentSource;
  jobStatus: JobStatus | null;
}

/**
 * Priority order (first match wins):
 *   needs_you — herdr `blocked`, or claude `waiting`
 *   working   — herdr `working`, or claude `busy`, or a dispatch job `running`/`pending`
 *   stale     — herdr `idle`/`done` and lastActivityAt older than staleAfterMs
 *   idle      — herdr `idle`
 *   done      — herdr `done`, or a terminal dispatch job (done/failed/interrupted)
 *   unknown   — anything else
 *
 * Dispatch jobs whose result carries a needs-human verdict are NOT distinguished into
 * needs_you here — that signal isn't cheaply available without a tool-specific parse of
 * `job.result`, so a dispatch job only ever resolves to working/done/unknown. See
 * server/routes/agents.ts's caller for the corresponding warning-free skip.
 */
export function deriveState(input: DeriveStateInput): AgentState {
  const { herdrStatus, claudeStatus, lastActivityAt, now, staleAfterMs, source, jobStatus } = input;

  if (herdrStatus === "blocked" || claudeStatus === "waiting") return "needs_you";

  if (herdrStatus === "working" || claudeStatus === "busy") return "working";
  if (source === "dispatch" && (jobStatus === "running" || jobStatus === "pending")) {
    return "working";
  }

  if (herdrStatus === "idle" || herdrStatus === "done") {
    if (lastActivityAt != null && now - lastActivityAt > staleAfterMs) return "stale";
  }

  if (herdrStatus === "idle") return "idle";
  if (herdrStatus === "done") return "done";
  if (
    source === "dispatch" &&
    jobStatus != null &&
    jobStatus !== "running" &&
    jobStatus !== "pending"
  ) {
    return "done";
  }

  return "unknown";
}

// ── Pure: merge + group + sort ──────────────────────────────────────────────────────────────

export interface HerdrAgentRaw {
  agent_session: { value: string } | null;
  agent_status: string;
  cwd: string;
  pane_id: string;
  workspace_id: string;
  terminal_title_stripped: string;
}

export interface HerdrWorkspaceRaw {
  workspace_id: string;
  label: string;
}

export interface ClaudeAgentRaw {
  cwd: string;
  sessionId: string;
  startedAt: number;
  status: string;
  waitingFor?: string;
}

export interface DispatchJobRaw {
  id: string;
  status: JobStatus;
  cwd: string;
  tier: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface MergeAgentsInput {
  herdrAgents: HerdrAgentRaw[];
  herdrWorkspaces: HerdrWorkspaceRaw[];
  claudeAgents: ClaudeAgentRaw[];
  dispatchJobs: DispatchJobRaw[];
  /** Resolved transcript tails, keyed by Claude sessionId. Reading them is I/O, so the caller
   *  resolves this map before calling into this pure function. */
  transcripts: Map<string, TranscriptTail>;
  now: number;
  staleAfterMs: number;
}

export interface MergedProject {
  name: string;
  cwd: string;
  agents: Agent[];
}

function normalizeHerdrStatus(raw: string): HerdrAgentStatus {
  return raw === "working" || raw === "idle" || raw === "blocked" || raw === "done"
    ? raw
    : "unknown";
}

function normalizeClaudeStatus(raw: string): ClaudeAgentStatus | null {
  return raw === "idle" || raw === "busy" || raw === "waiting" ? raw : null;
}

function normalizeTier(raw: string | null): DispatchTierName | null {
  return raw === "investigate" || raw === "author" || raw === "implement" ? raw : null;
}

const STATE_RANK: Record<AgentState, number> = {
  needs_you: 0,
  working: 1,
  idle: 2,
  stale: 3,
  done: 4,
  unknown: 5,
};

/**
 * Merges the three collector outputs into one project-grouped, urgency-sorted snapshot.
 * Entries are keyed by Claude sessionId (herdr pane + claude registry entry with the same
 * sessionId collapse into one Agent, herdr's status winning); dispatch jobs are never keyed by
 * sessionId (they have none) and always become their own entry.
 */
export function mergeAgents(input: MergeAgentsInput): MergedProject[] {
  const {
    herdrAgents,
    herdrWorkspaces,
    claudeAgents,
    dispatchJobs,
    transcripts,
    now,
    staleAfterMs,
  } = input;

  const workspaceLabels = new Map(herdrWorkspaces.map((w) => [w.workspace_id, w.label]));

  interface Entry {
    agent: Agent;
    jobStatus: JobStatus | null;
    workspaceId: string | null;
    cwd: string;
  }
  const bySessionId = new Map<string, Entry>();

  for (const a of herdrAgents) {
    const sessionId = a.agent_session?.value ?? null;
    const key = sessionId ?? `pane:${a.pane_id}`;
    const tail = sessionId ? (transcripts.get(sessionId) ?? EMPTY_TAIL) : EMPTY_TAIL;
    bySessionId.set(key, {
      jobStatus: null,
      workspaceId: a.workspace_id,
      cwd: a.cwd,
      agent: {
        id: sessionId ?? a.pane_id,
        source: "herdr",
        sessionId,
        paneId: a.pane_id,
        workspaceId: a.workspace_id,
        title: a.terminal_title_stripped || tail.aiTitle || null,
        state: "unknown",
        herdrStatus: normalizeHerdrStatus(a.agent_status),
        claudeStatus: null,
        waitingFor: null,
        tier: null,
        lastPrompt: tail.lastPrompt,
        lastReply: tail.lastReply,
        lastActivityAt: tail.lastActivityAt,
        startedAt: null,
      },
    });
  }

  for (const c of claudeAgents) {
    const existing = bySessionId.get(c.sessionId);
    const claudeStatus = normalizeClaudeStatus(c.status);
    if (existing) {
      existing.agent.claudeStatus = claudeStatus;
      existing.agent.waitingFor = c.waitingFor ?? null;
      existing.agent.startedAt = c.startedAt;
      continue;
    }
    const tail = transcripts.get(c.sessionId) ?? EMPTY_TAIL;
    bySessionId.set(c.sessionId, {
      jobStatus: null,
      workspaceId: null,
      cwd: c.cwd,
      agent: {
        id: c.sessionId,
        source: "claude",
        sessionId: c.sessionId,
        paneId: null,
        workspaceId: null,
        title: tail.aiTitle,
        state: "unknown",
        herdrStatus: null,
        claudeStatus,
        waitingFor: c.waitingFor ?? null,
        tier: null,
        lastPrompt: tail.lastPrompt,
        lastReply: tail.lastReply,
        lastActivityAt: tail.lastActivityAt,
        startedAt: c.startedAt,
      },
    });
  }

  for (const job of dispatchJobs) {
    bySessionId.set(`dispatch:${job.id}`, {
      jobStatus: job.status,
      workspaceId: null,
      cwd: job.cwd,
      agent: {
        id: job.id,
        source: "dispatch",
        sessionId: null,
        paneId: null,
        workspaceId: null,
        title: null,
        state: "unknown",
        herdrStatus: null,
        claudeStatus: null,
        waitingFor: null,
        tier: normalizeTier(job.tier),
        lastPrompt: null,
        lastReply: null,
        lastActivityAt: job.finishedAt ?? job.startedAt ?? job.createdAt,
        startedAt: job.startedAt ?? job.createdAt,
      },
    });
  }

  const groups = new Map<string, MergedProject>();
  for (const entry of bySessionId.values()) {
    entry.agent.state = deriveState({
      herdrStatus: entry.agent.herdrStatus,
      claudeStatus: entry.agent.claudeStatus,
      lastActivityAt: entry.agent.lastActivityAt,
      now,
      staleAfterMs,
      source: entry.agent.source,
      jobStatus: entry.jobStatus,
    });

    const projectName =
      entry.workspaceId && workspaceLabels.has(entry.workspaceId)
        ? (workspaceLabels.get(entry.workspaceId) as string)
        : basename(entry.cwd);

    const existingGroup = groups.get(projectName);
    if (existingGroup) {
      existingGroup.agents.push(entry.agent);
    } else {
      groups.set(projectName, { name: projectName, cwd: entry.cwd, agents: [entry.agent] });
    }
  }

  const projectRank = (g: MergedProject): number =>
    Math.min(...g.agents.map((a) => STATE_RANK[a.state]));

  return [...groups.values()].toSorted((x, y) => {
    const rx = projectRank(x);
    const ry = projectRank(y);
    if (rx !== ry) return rx - ry;
    return x.name.localeCompare(y.name);
  });
}

// ── Pure: text rendering ─────────────────────────────────────────────────────────────────────

const STATE_ICON: Record<AgentState, string> = {
  needs_you: "!",
  working: "●", // ●
  idle: "○", // ○
  stale: "·", // ·
  done: "✓", // ✓
  unknown: "?",
};

const MAX_LINE_CHARS = 110;
const MAX_TITLE_CHARS = 48;
// MAX_LINE_CHARS minus the "      — " prefix (8 chars) the standing line is rendered with —
// sized so `truncate`'s own elided "…" survives clampLine's hard cut rather than being sliced
// off by it (truncate elides at maxChars, clampLine would otherwise cut mid-ellipsis).
const MAX_STANDING_CHARS = MAX_LINE_CHARS - 8;

// ── ANSI colour (opt-in, `?color=1`/`?ansi=1` on the .txt routes) ──────────────────────────────
//
// SGR only, no 256/truecolor — this renders in a herdr pane via `watch --color`, and plain
// output must stay byte-identical when the flag is absent. Every coloured span resets before
// the newline, so a truncated line or a terminal that dies mid-stream never leaks colour into
// whatever follows.

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const BOLD_RED = `${BOLD}${RED}`;
const DIM_GREEN = `${DIM}${GREEN}`;

/** Strips SGR escape sequences — used by tests to assert `stripAnsi(coloured) === plain`, and
 *  internally to measure a coloured line's VISIBLE width for the 110-char clamp (never the
 *  escape bytes). A manual scan rather than a `/\x1b.../ ` regex literal — oxlint's
 *  `no-control-regex` flags the literal ESC byte in a regex pattern regardless of intent. */
export function stripAnsi(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b") {
      const end = text.indexOf("m", i);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/** A per-agent line/bar-bucket is coloured by its `overview` recommendation when enrichment is
 *  present, else by its deterministic `state` — EXCEPT `needs_you` always wins regardless of
 *  what the model recommended: a herdr-blocked/waiting pane is never allowed to render as
 *  anything but urgent, even if a stale `overview` job called it "stale" before it needed a
 *  human. The icon is untouched by this — only colour. */
function effectiveCategory(
  state: AgentState,
  enrichment: AgentEnrichment | undefined,
): Recommendation | AgentState {
  if (state === "needs_you") return "needs_you";
  return enrichment ? enrichment.recommendation : state;
}

/** Both enums share the string "stale", so one switch covers both without a discriminant. */
function categoryColor(category: Recommendation | AgentState): string {
  switch (category) {
    case "answer":
    case "needs_you":
      return BOLD_RED;
    case "ship":
    case "merge":
      return YELLOW;
    case "review":
      return MAGENTA;
    case "working":
    case "watch":
      return GREEN;
    case "continue":
      return CYAN;
    case "idle":
    case "stale":
      return DIM;
    case "done":
    case "close":
      return DIM_GREEN;
    default:
      return "";
  }
}

// Doubled "!!" for the answer/needs_you bucket in the SUMMARY BAR only — a single "!" is easy
// to miss skimming a herdr pane, and the bar is the one place that glyph stands alone (the
// per-line icon stays RECOMMENDATION_ICON/STATE_ICON, unchanged from plain mode).
const BAR_ICON: Record<Recommendation | AgentState, string> = {
  answer: "!!",
  needs_you: "!!",
  continue: "→",
  ship: "⇧",
  review: "⚑",
  merge: "⇄",
  close: "✓",
  done: "✓",
  stale: "·",
  watch: "●",
  working: "●",
  idle: "○",
  unknown: "?",
};

// The bar counts by ONE enum at a time, never both — mixing recommendation buckets (e.g.
// "watch") with state buckets (e.g. "working") let two different categories land on the same
// glyph ("●" for both), rendering as a duplicate. Each list's own icons are internally unique
// (checked by tests/agents.test.ts's "no glyph repeats" test), so picking one list per call is
// what guarantees that, not a de-dup step after the fact.
const RECOMMENDATION_BAR_ORDER: Recommendation[] = [
  "answer",
  "ship",
  "merge",
  "review",
  "continue",
  "watch",
  "close",
  "stale",
];
const STATE_BAR_ORDER: AgentState[] = ["needs_you", "working", "idle", "stale", "done", "unknown"];

/** Clamps a (possibly ANSI-coloured) line to `maxChars` VISIBLE characters, passing escape
 *  bytes through uncounted, and always closing with a reset so a mid-escape cut can never
 *  leak colour into the next line. No-ops (returns `line` unchanged) when already within
 *  budget, so an uncoloured caller pays nothing extra. */
function clampVisible(line: string, maxChars: number): string {
  if (stripAnsi(line).length <= maxChars) return line;
  let visible = 0;
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const end = line.indexOf("m", i);
      if (end === -1) break;
      out += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (visible >= maxChars) break;
    out += line[i];
    visible += 1;
    i += 1;
  }
  return `${out}${RESET}`;
}

/** The coloured mode's compact summary bar. When a completed `overview` job exists, counts
 *  by RECOMMENDATION only (an agent with no recommendation — no cached verdict yet, or nulled
 *  by the staleness rule — folds into a trailing plain `? n`, never a state icon standing in
 *  for it); with no overview at all (the plain `/api/agents.txt` colour path), counts by STATE
 *  only. The two enums are never mixed in one bar — see the two order lists above. Non-zero
 *  buckets only, most-urgent-first. Null when there is nothing to summarize. Plain (uncoloured)
 *  mode never calls this. */
function buildRecommendationBar(
  projects: Project[],
  enrichment: Map<string, AgentEnrichment> | undefined,
  overviewExists: boolean,
): string | null {
  const parts: string[] = [];

  if (overviewExists) {
    const counts = new Map<Recommendation, number>();
    let unrecommended = 0;
    for (const project of projects) {
      for (const agent of project.agents) {
        const rec = enrichment?.get(agent.id)?.recommendation;
        if (rec) counts.set(rec, (counts.get(rec) ?? 0) + 1);
        else unrecommended += 1;
      }
    }
    for (const rec of RECOMMENDATION_BAR_ORDER) {
      const n = counts.get(rec);
      if (!n) continue;
      const color = categoryColor(rec);
      const segment = `${BAR_ICON[rec]} ${n}`;
      parts.push(color ? `${color}${segment}${RESET}` : segment);
    }
    if (unrecommended > 0) parts.push(`? ${unrecommended}`);
  } else {
    const counts = new Map<AgentState, number>();
    for (const project of projects) {
      for (const agent of project.agents) {
        counts.set(agent.state, (counts.get(agent.state) ?? 0) + 1);
      }
    }
    for (const state of STATE_BAR_ORDER) {
      const n = counts.get(state);
      if (!n) continue;
      const color = categoryColor(state);
      const segment = `${BAR_ICON[state]} ${n}`;
      parts.push(color ? `${color}${segment}${RESET}` : segment);
    }
  }

  return parts.length > 0 ? parts.join("   ") : null;
}

/** Exported for the `overview` job's prompt builder, which needs identical "N ago" phrasing
 *  for the facts it hands the LLM — one source of truth for the format, not a second copy. */
export function relativeAge(ms: number | null, now: number): string {
  if (ms == null) return "?";
  const deltaSec = Math.max(0, Math.round((now - ms) / 1000));
  if (deltaSec < 60) return `${deltaSec}s`;
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m`;
  const deltaHour = Math.round(deltaMin / 60);
  if (deltaHour < 24) return `${deltaHour}h`;
  const deltaDay = Math.round(deltaHour / 24);
  return `${deltaDay}d`;
}

/** Exported for the same reason as `relativeAge` — the `overview` prompt builder caps
 *  lastPrompt/lastReply excerpts and should truncate identically to this renderer. */
export function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function clampLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
}

/** Per-agent LLM enrichment, keyed by agent id — the `overview` job's result merged onto a
 *  fresh deterministic snapshot by `GET /api/overview`. Absent (or the agent's id missing
 *  from the map) means "no recommendation available", which `renderText` falls back on the
 *  deterministic `state` icon for — never a blank icon. */
export interface AgentEnrichment {
  recommendation: Recommendation;
  standing: string | null;
}

export interface RenderTextOptions {
  enrichment?: Map<string, AgentEnrichment>;
  /** `/api/overview`'s job metadata, or null when no `overview` job has ever completed.
   *  Omit entirely (undefined) to render exactly like the plain `/api/agents.txt` — this is
   *  what keeps the two callers sharing one renderer without a duplicate copy. */
  overview?: { ageMs: number } | null;
  /** Opt-in ANSI colour (`?color=1`/`?ansi=1` on the .txt routes, for `watch --color` in the
   *  herdr overview pane). Omitted or `false` renders byte-identical plain text — this is what
   *  keeps every pre-existing test and caller unaffected. */
  color?: boolean;
}

/** Renders the same snapshot GET /api/agents returns as compact plain text for `watch`.
 *  `GET /api/overview.txt` calls this with `opts.enrichment`/`opts.overview` to swap the
 *  deterministic state icon for a recommendation icon and add a standing line — see
 *  CLAUDE.md's `### overview` section. Called with no `opts` (the plain `/api/agents.txt`
 *  path), behavior is byte-identical to before enrichment existed. `opts.color` (see
 *  `RenderTextOptions`) additionally colours every span with SGR codes and prepends a
 *  recommendation-count summary bar — `stripAnsi()` of that output (minus the bar line)
 *  is byte-identical to the uncoloured render. */
export function renderText(snapshot: AgentsSnapshot, opts?: RenderTextOptions): string {
  const { summary, generatedAt, projects } = snapshot;
  const color = opts?.color === true;
  const lines: string[] = [];

  const generatedAtIso = new Date(generatedAt).toISOString();
  let header =
    `agents: ${summary.needsYou} needs_you · ${summary.working} working · ${summary.idle} idle · ` +
    `${summary.stale} stale · ${summary.done} done · ${summary.dispatch} dispatch  (${generatedAtIso})`;
  if (opts && "overview" in opts) {
    header +=
      opts.overview != null
        ? `  · overview ${relativeAge(generatedAt - opts.overview.ageMs, generatedAt)}`
        : "  · overview none";
  }
  // NOT clampLine'd: the header is entirely first-party, bounded content (summary counts, an
  // ISO timestamp, the short overview suffix) — clampLine's cap exists to bound EXTERNALLY-
  // influenced text (an agent's title/waitingFor), and the base header (100 chars) plus the
  // overview suffix (~15-18 chars) already exceeds 110, so clamping it would silently drop
  // the "overview <age>"/"overview none" suffix the caller asked for on every call.
  lines.push(color ? `${DIM}${header}${RESET}` : header);

  if (color) {
    const bar = buildRecommendationBar(projects, opts?.enrichment, opts?.overview != null);
    if (bar) lines.push(bar);
  }

  for (const project of projects) {
    const branch = project.git ? project.git.branch + (project.git.dirty ? "*" : "") : "?";
    if (color) {
      const branchName = project.git ? project.git.branch : "?";
      const dirty = project.git?.dirty ?? false;
      const coloredBranch = `${CYAN}${branchName}${RESET}${dirty ? `${RED}*${RESET}` : ""}`;
      const projectLine =
        `${BOLD}▸ ${project.name}  ${RESET}${coloredBranch}` +
        `${BOLD}  [${project.agents.length} agents]${RESET}`;
      lines.push(clampVisible(projectLine, MAX_LINE_CHARS));
    } else {
      lines.push(clampLine(`▸ ${project.name}  ${branch}  [${project.agents.length} agents]`));
    }

    for (const agent of project.agents) {
      const enrichment = opts?.enrichment?.get(agent.id);
      const icon = enrichment
        ? RECOMMENDATION_ICON[enrichment.recommendation]
        : STATE_ICON[agent.state];
      const statePadded = agent.state.padEnd(9);
      const title = truncate(agent.title ?? "(untitled)", MAX_TITLE_CHARS);
      const age = relativeAge(agent.lastActivityAt, generatedAt);
      const base = `  ${icon} ${statePadded} ${title}  · ${age}`;

      if (color) {
        const category = effectiveCategory(agent.state, enrichment);
        const spanColor = categoryColor(category);
        let line = spanColor ? `${spanColor}${base}${RESET}` : base;
        if (agent.waitingFor) line += `${RED}  · ${agent.waitingFor}${RESET}`;
        lines.push(clampVisible(line, MAX_LINE_CHARS));
        if (enrichment?.standing) {
          const standingText = `      — ${truncate(enrichment.standing, MAX_STANDING_CHARS)}`;
          lines.push(clampVisible(`${DIM}${standingText}${RESET}`, MAX_LINE_CHARS));
        }
      } else {
        let line = base;
        if (agent.waitingFor) line += `  · ${agent.waitingFor}`;
        lines.push(clampLine(line));
        if (enrichment?.standing) {
          lines.push(clampLine(`      — ${truncate(enrichment.standing, MAX_STANDING_CHARS)}`));
        }
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

// ── Impure collectors ────────────────────────────────────────────────────────────────────────

const HERDR_BIN = existsSync(join(homedir(), ".local/bin/herdr"))
  ? join(homedir(), ".local/bin/herdr")
  : "herdr";
const CLAUDE_BIN = existsSync(join(homedir(), ".local/bin/claude"))
  ? join(homedir(), ".local/bin/claude")
  : "claude";

const CLI_TIMEOUT_MS = 5_000;
const TAIL_BYTES = 512 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;

async function runCli(cmd: string[], timeoutMs = CLI_TIMEOUT_MS): Promise<string | null> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  try {
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (timedOut || code !== 0) return null;
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface CollectorResult<T> {
  items: T[];
  warning: string | null;
}

/** `herdr agent list` → the herdr-tracked panes running a Claude agent. */
export async function readHerdrAgents(): Promise<CollectorResult<HerdrAgentRaw>> {
  const out = await runCli([HERDR_BIN, "agent", "list"]);
  if (out == null) return { items: [], warning: "herdr agent list failed or timed out" };
  try {
    const parsed = JSON.parse(out) as { result?: { agents?: unknown[] } };
    const agents = (parsed.result?.agents ?? []) as HerdrAgentRaw[];
    return { items: agents, warning: null };
  } catch {
    return { items: [], warning: "herdr agent list returned unparseable JSON" };
  }
}

/** `herdr workspace list` → workspace_id → label (project name), used to name projects. */
export async function readHerdrWorkspaces(): Promise<CollectorResult<HerdrWorkspaceRaw>> {
  const out = await runCli([HERDR_BIN, "workspace", "list"]);
  if (out == null) return { items: [], warning: "herdr workspace list failed or timed out" };
  try {
    const parsed = JSON.parse(out) as { result?: { workspaces?: unknown[] } };
    const workspaces = (parsed.result?.workspaces ?? []) as HerdrWorkspaceRaw[];
    return { items: workspaces, warning: null };
  } catch {
    return { items: [], warning: "herdr workspace list returned unparseable JSON" };
  }
}

/** `claude agents --json` → Claude's own registry, including `claude --bg` daemons with no
 *  herdr pane. */
export async function readClaudeAgents(): Promise<CollectorResult<ClaudeAgentRaw>> {
  const out = await runCli([CLAUDE_BIN, "agents", "--json"]);
  if (out == null) return { items: [], warning: "claude agents --json failed or timed out" };
  try {
    const parsed = JSON.parse(out) as unknown[];
    return { items: parsed as ClaudeAgentRaw[], warning: null };
  } catch {
    return { items: [], warning: "claude agents --json returned unparseable JSON" };
  }
}

/**
 * Reads the tail of a transcript file at `path` and parses it, growing the read window when
 * the first pass finds no timestamp. Never throws — a missing file (session not yet flushed,
 * or predates transcript logging) yields the all-null tail. Split out from `readSessionTail`
 * (which resolves the real `~/.claude/projects/...` path) so tests can exercise the read
 * against a real temp file.
 *
 * File mtime is deliberately NOT used as a signal here: Claude Code touches an otherwise-idle
 * session's transcript file (measured — a session last active 2026-09-04 had an mtime from
 * today), so mtime tracks "the CLI process is still resident," not "the user said something."
 * Only a parsed line timestamp counts as activity.
 */
export async function readTranscriptTailFile(path: string): Promise<TranscriptTail> {
  const file = Bun.file(path);
  if (!(await file.exists())) return EMPTY_TAIL;
  const size = file.size;

  let attemptBytes = TAIL_BYTES;
  let tail: TranscriptTail = EMPTY_TAIL;
  // Progressive tail: 512 KB, then 4x per retry (2 MB, 8 MB), stopping once a pass finds a
  // timestamp, the window already covers the whole file (start === 0), or the window has
  // grown to MAX_TAIL_BYTES. This is what a fixed-size tail read cannot do on its own: a
  // single JSONL line (e.g. an extended-thinking signature blob) larger than the window
  // pushes every complete assistant/user line before it, and the first pass never reaches a
  // parseable line.
  for (;;) {
    const start = Math.max(0, size - attemptBytes);
    const raw = await file.slice(start, size).text();
    // Drop the first (possibly partial) line unless we're reading from byte 0.
    const firstNewline = raw.indexOf("\n");
    const text = start > 0 && firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
    tail = parseTranscriptTail(text);
    if (tail.lastActivityAt != null) return tail;
    if (start === 0 || attemptBytes >= MAX_TAIL_BYTES) return tail;
    attemptBytes = Math.min(attemptBytes * 4, MAX_TAIL_BYTES);
  }
}

/** Resolves a session's real transcript path and delegates to `readTranscriptTailFile`. */
export async function readSessionTail(cwd: string, sessionId: string): Promise<TranscriptTail> {
  const path = join(homedir(), ".claude", "projects", encodeProjectDir(cwd), `${sessionId}.jsonl`);
  try {
    return await readTranscriptTailFile(path);
  } catch (err) {
    logger.warn(
      {
        event: "agents.transcript_read_failed",
        tool: "agents",
        cwd,
        sessionId,
        error: String(err),
      },
      "session transcript tail read failed",
    );
    return EMPTY_TAIL;
  }
}

/** Dispatch jobs relevant to the overview: running/queued, plus terminal ones from the last 6h. */
const DISPATCH_RECENT_MS = 6 * 60 * 60 * 1000;

export function collectDispatchJobs(records: JobRecord[], now: number): DispatchJobRaw[] {
  return records
    .filter((r) => r.tool === "dispatch")
    .filter((r) => {
      if (r.status === "running" || r.status === "pending") return true;
      const finishedAt = r.finishedAt ?? r.createdAt;
      return now - finishedAt <= DISPATCH_RECENT_MS;
    })
    .map((r) => ({
      id: r.id,
      status: r.status,
      cwd: typeof r.params.cwd === "string" ? r.params.cwd : "",
      tier: typeof r.params.tier === "string" ? r.params.tier : null,
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    }))
    .filter((j) => j.cwd !== "");
}

const DEFAULT_STALE_HOURS = 24;

export function staleAfterHours(): number {
  const raw = process.env.SIDECLAW_AGENT_STALE_HOURS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_HOURS;
}

// ── The one snapshot builder ─────────────────────────────────────────────────────────────────
//
// Single producer behind `GET /api/agents` (routes/agents.ts) AND the `overview` job
// (jobs/handlers/overview.ts) — the latter calls this in-process rather than looping back
// over HTTP to itself. Originally lived inline in routes/agents.ts; moved here so both
// callers import the same function instead of one re-deriving it.

/** Override the stale-agent threshold used to derive each agent's `state` — the `overview`
 *  job's `staleAfterHours` input param. Omitted (the `GET /api/agents` path): read from
 *  `SIDECLAW_AGENT_STALE_HOURS` via `staleAfterHours()`, unchanged from before this param
 *  existed. */
export async function buildSnapshot(staleHoursOverride?: number): Promise<AgentsSnapshot> {
  const now = Date.now();
  const staleHours = staleHoursOverride ?? staleAfterHours();
  const staleAfterMs = staleHours * 60 * 60 * 1000;

  const [herdrAgentsResult, herdrWorkspacesResult, claudeAgentsResult] = await Promise.all([
    readHerdrAgents(),
    readHerdrWorkspaces(),
    readClaudeAgents(),
  ]);

  const warnings = [
    herdrAgentsResult.warning,
    herdrWorkspacesResult.warning,
    claudeAgentsResult.warning,
  ].filter((w): w is string => w != null);

  // Unique (cwd, sessionId) pairs across both sources — a herdr pane and its claude registry
  // counterpart share the same sessionId and only need one transcript read.
  const sessionsByCwd = new Map<string, string>();
  for (const a of herdrAgentsResult.items) {
    const sessionId = a.agent_session?.value;
    if (sessionId) sessionsByCwd.set(sessionId, a.cwd);
  }
  for (const c of claudeAgentsResult.items) {
    sessionsByCwd.set(c.sessionId, c.cwd);
  }

  const tailEntries = await Promise.all(
    [...sessionsByCwd.entries()].map(
      async ([sessionId, cwd]): Promise<[string, TranscriptTail]> => [
        sessionId,
        await readSessionTail(cwd, sessionId),
      ],
    ),
  );
  const transcripts = new Map(tailEntries);

  const dispatchJobs = collectDispatchJobs(listJobRecords(), now);

  const projects = mergeAgents({
    herdrAgents: herdrAgentsResult.items,
    herdrWorkspaces: herdrWorkspacesResult.items,
    claudeAgents: claudeAgentsResult.items,
    dispatchJobs,
    transcripts,
    now,
    staleAfterMs,
  });

  const projectsWithGit = await Promise.all(
    projects.map(async (project) => {
      let git: ProjectGit | null = null;
      try {
        const status = await getGitStatus(project.cwd);
        if (status) {
          const commit = status.branchCommits[0] ?? status.masterCommits[0] ?? null;
          git = {
            branch: status.branch,
            dirty: status.changedFiles.length > 0,
            ahead: status.ahead,
            behind: status.behind,
            lastCommit: commit
              ? { sha: commit.sha, subject: commit.subject, at: commit.committedAt }
              : null,
          };
        }
      } catch (err) {
        warnings.push(`git status failed for ${project.name}: ${String(err)}`);
      }
      return { name: project.name, cwd: project.cwd, git, agents: project.agents };
    }),
  );

  const summary: AgentsSummary = {
    needsYou: 0,
    working: 0,
    idle: 0,
    stale: 0,
    done: 0,
    dispatch: 0,
  };
  for (const project of projectsWithGit) {
    for (const agent of project.agents) {
      if (agent.source === "dispatch") summary.dispatch += 1;
      switch (agent.state) {
        case "needs_you":
          summary.needsYou += 1;
          break;
        case "working":
          summary.working += 1;
          break;
        case "idle":
          summary.idle += 1;
          break;
        case "stale":
          summary.stale += 1;
          break;
        case "done":
          summary.done += 1;
          break;
        default:
          break;
      }
    }
  }

  return {
    generatedAt: now,
    staleAfterHours: staleHours,
    summary,
    projects: projectsWithGit,
    warnings,
  };
}
