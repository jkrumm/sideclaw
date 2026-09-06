import { basename, join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { z } from "zod";
import { appLogger as logger } from "../logger.ts";
import type { JobRecord, JobStatus } from "../jobs/types.ts";

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
        "at 400 chars. Null if unavailable.",
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

const MAX_REPLY_CHARS = 400;

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

function relativeAge(ms: number | null, now: number): string {
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

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function clampLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
}

/** Renders the same snapshot GET /api/agents returns as compact plain text for `watch`. */
export function renderText(snapshot: AgentsSnapshot): string {
  const { summary, generatedAt, projects } = snapshot;
  const lines: string[] = [];

  const generatedAtIso = new Date(generatedAt).toISOString();
  lines.push(
    clampLine(
      `agents: ${summary.needsYou} needs_you · ${summary.working} working · ${summary.idle} idle · ` +
        `${summary.stale} stale · ${summary.done} done · ${summary.dispatch} dispatch  (${generatedAtIso})`,
    ),
  );

  for (const project of projects) {
    const branch = project.git ? project.git.branch + (project.git.dirty ? "*" : "") : "?";
    lines.push(clampLine(`▸ ${project.name}  ${branch}  [${project.agents.length} agents]`));

    for (const agent of project.agents) {
      const icon = STATE_ICON[agent.state];
      const statePadded = agent.state.padEnd(9);
      const title = truncate(agent.title ?? "(untitled)", MAX_TITLE_CHARS);
      const age = relativeAge(agent.lastActivityAt, generatedAt);
      let line = `  ${icon} ${statePadded} ${title}  · ${age}`;
      if (agent.waitingFor) line += `  · ${agent.waitingFor}`;
      lines.push(clampLine(line));
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
