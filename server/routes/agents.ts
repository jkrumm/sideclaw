import { Elysia } from "elysia";
import { parseCols, renderText, type AgentEnrichment } from "../lib/agents.ts";
import { buildOverviewPayload, cachedBuildSnapshot } from "../lib/overview-payload.ts";
import { appLogger as logger } from "../logger.ts";

// Deterministic, read-only, no-LLM agent overview: one JSON snapshot of every Claude Code
// agent on this Mac mini, grouped by project. Single producer behind Hermes, an Argo
// dashboard, a brain page and a herdr pane. See CLAUDE.md's `### agents` section.
//
// `buildSnapshot` itself lives in lib/agents.ts — the `overview` job calls it in-process
// too, rather than looping back over HTTP to this route. The routes here read it through
// `cachedBuildSnapshot` (20 s, lib/overview-payload.ts): the herdr pane, Hermes and the
// Argo push all poll within seconds of each other and share one build.

export const agentsRoutes = new Elysia({ prefix: "/api" })
  .get("/agents", async () => {
    const startMs = performance.now();
    logger.info(
      { event: "agents.request", tool: "agents", format: "json" },
      "agents snapshot requested",
    );
    const data = await cachedBuildSnapshot();
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
  .get("/agents.txt", async ({ query, set }) => {
    const startMs = performance.now();
    const color = query.color === "1" || query.ansi === "1";
    const cols = parseCols(query.cols);
    logger.info(
      { event: "agents.request", tool: "agents", format: "text" },
      "agents snapshot requested",
    );
    const data = await cachedBuildSnapshot();
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
    return renderText(data, { color, cols });
  })
  .get("/overview", async () => {
    const startMs = performance.now();
    logger.info(
      { event: "overview.request", tool: "overview", format: "json" },
      "overview snapshot requested",
    );
    const { merged, payload } = await buildOverviewPayload();
    logger.info(
      {
        event: "overview.response",
        tool: "overview",
        format: "json",
        projects: payload.projects.length,
        cached: merged.overview != null,
        durationMs: Math.round(performance.now() - startMs),
      },
      "overview snapshot built",
    );
    return { ok: true, data: payload };
  })
  .get("/overview.txt", async ({ query, set }) => {
    const startMs = performance.now();
    const color = query.color === "1" || query.ansi === "1";
    const cols = parseCols(query.cols);
    logger.info(
      { event: "overview.request", tool: "overview", format: "text" },
      "overview snapshot requested",
    );
    const { snapshot, merged } = await buildOverviewPayload();
    const enrichment = new Map<string, AgentEnrichment>();
    for (const project of merged.projects) {
      for (const agent of project.agents) {
        if (agent.recommendation) {
          enrichment.set(agent.id, {
            recommendation: agent.recommendation,
            standing: agent.standing,
          });
        }
      }
    }
    set.headers["content-type"] = "text/plain; charset=utf-8";
    logger.info(
      {
        event: "overview.response",
        tool: "overview",
        format: "text",
        projects: merged.projects.length,
        cached: merged.overview != null,
        durationMs: Math.round(performance.now() - startMs),
      },
      "overview snapshot built",
    );
    return renderText(snapshot, { enrichment, overview: merged.overview, color, cols });
  });
