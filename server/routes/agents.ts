import { Elysia } from "elysia";
import { buildSnapshot, renderText, type AgentEnrichment } from "../lib/agents.ts";
import { latestJobResult } from "../jobs/store.ts";
import {
  mergeOverviewIntoSnapshot,
  OVERVIEW_OUTPUT,
  type OverviewOutput,
} from "../jobs/handlers/overview.ts";
import { appLogger as logger } from "../logger.ts";

// Deterministic, read-only, no-LLM agent overview: one JSON snapshot of every Claude Code
// agent on this Mac mini, grouped by project. Single producer behind Hermes, an Argo
// dashboard, a brain page and a herdr pane. See CLAUDE.md's `### agents` section.
//
// `buildSnapshot` itself now lives in lib/agents.ts — the `overview` job calls it
// in-process too, rather than looping back over HTTP to this route.

/** Reads the latest completed `overview` job result, re-validated against its own output
 *  schema (the row is untyped JSON from sqlite) — a schema drift between an old cached job
 *  and the current OVERVIEW_OUTPUT shape degrades to "no cached overview" rather than a
 *  500. */
function readCachedOverview(): OverviewOutput | null {
  const cached = latestJobResult("overview");
  if (!cached) return null;
  const parsed = OVERVIEW_OUTPUT.safeParse(cached.result);
  if (!parsed.success) {
    logger.warn(
      { event: "overview.cache_parse_failed", tool: "overview", error: parsed.error.message },
      "cached overview job result failed schema validation — treating as absent",
    );
    return null;
  }
  return parsed.data;
}

/** Fresh deterministic snapshot + the latest completed overview job, merged by agent id. Both
 *  GET /api/overview and GET /api/overview.txt share this — the JSON route returns the merged
 *  projects/agents directly, the text route additionally projects it into `renderText`'s
 *  enrichment map. */
async function buildOverviewResponse() {
  const snapshot = await buildSnapshot();
  const cached = readCachedOverview();
  const merged = mergeOverviewIntoSnapshot(snapshot, cached);
  return { snapshot, merged };
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
  })
  .get("/overview", async () => {
    const startMs = performance.now();
    logger.info(
      { event: "overview.request", tool: "overview", format: "json" },
      "overview snapshot requested",
    );
    const { snapshot, merged } = await buildOverviewResponse();
    const data = { ...snapshot, projects: merged.projects, overview: merged.overview };
    logger.info(
      {
        event: "overview.response",
        tool: "overview",
        format: "json",
        projects: data.projects.length,
        cached: merged.overview != null,
        durationMs: Math.round(performance.now() - startMs),
      },
      "overview snapshot built",
    );
    return { ok: true, data };
  })
  .get("/overview.txt", async ({ set }) => {
    const startMs = performance.now();
    logger.info(
      { event: "overview.request", tool: "overview", format: "text" },
      "overview snapshot requested",
    );
    const { snapshot, merged } = await buildOverviewResponse();
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
    return renderText(snapshot, { enrichment, overview: merged.overview });
  });
