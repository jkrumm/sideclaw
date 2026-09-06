import { Elysia } from "elysia";
import {
  collectDispatchJobs,
  mergeAgents,
  readClaudeAgents,
  readHerdrAgents,
  readHerdrWorkspaces,
  readSessionTail,
  renderText,
  staleAfterHours,
  type AgentsSnapshot,
  type AgentsSummary,
  type ProjectGit,
  type TranscriptTail,
} from "../lib/agents.ts";
import { getGitStatus } from "../lib/git.ts";
import { listJobRecords } from "../jobs/store.ts";
import { appLogger as logger } from "../logger.ts";

// Deterministic, read-only, no-LLM agent overview: one JSON snapshot of every Claude Code
// agent on this Mac mini, grouped by project. Single producer behind Hermes, an Argo
// dashboard, a brain page and a herdr pane. See CLAUDE.md's `### agents` section.

async function buildSnapshot(): Promise<AgentsSnapshot> {
  const now = Date.now();
  const staleHours = staleAfterHours();
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

export const agentsRoutes = new Elysia({ prefix: "/api" })
  .get("/agents", async () => {
    const startMs = performance.now();
    logger.info(
      { event: "agents.request", tool: "agents", format: "json" },
      "agents snapshot requested",
    );
    const data = await buildSnapshot();
    logger.info(
      {
        event: "agents.response",
        tool: "agents",
        format: "json",
        projects: data.projects.length,
        warnings: data.warnings.length,
        durationMs: Math.round(performance.now() - startMs),
      },
      "agents snapshot built",
    );
    return { ok: true, data };
  })
  .get("/agents.txt", async ({ set }) => {
    const startMs = performance.now();
    logger.info(
      { event: "agents.request", tool: "agents", format: "text" },
      "agents snapshot requested",
    );
    const data = await buildSnapshot();
    set.headers["content-type"] = "text/plain; charset=utf-8";
    logger.info(
      {
        event: "agents.response",
        tool: "agents",
        format: "text",
        projects: data.projects.length,
        warnings: data.warnings.length,
        durationMs: Math.round(performance.now() - startMs),
      },
      "agents snapshot built",
    );
    return renderText(data);
  });
