// ── Tiered worker routing — the ONE place a tool's model and auth backend are decided ─────
//
// Every worker session (`runSession`) and the adversary text call pick their `{ model,
// backend, fallback }` from this table, keyed by tool. Nothing else hardcodes a model id:
// the job handlers pass `routeFor("<tool>")`, the MCP tool descriptions print the same
// route, and `GET /api/routing` exposes the effective table so an operator can see what
// a flipped env var actually did.
//
// Backends: `iu` (the IU unified endpoint's native Anthropic transport — metered per
// token, serves Claude AND gateway ids like glm-5.3-flash) and `max` (the inherited
// Claude Code OAuth profile — the Max subscription, Claude ids only).
//
// Fallback semantics (applied in session-runner.ts, one hop only, never a second one), purely
// REACTIVE — a session is only ever moved after a launch actually fails, never pre-empted:
//   primary `max` → `fallback.backend: "iu"`: a quota-flavoured failure before first output.
//   primary `iu`  → `fallback.backend: "max"`: the reverse lane — an IU transport failure
//     (or missing IU credentials) before first output moves the attempt onto Max, on
//     `fallback.model` when set (a gateway id cannot run on Max) or the same model when not.
// (A proactive Max-quota-ceiling pre-check used to also feed the first lane — removed
// 2026-09-08, see docs/routing-and-quota.md, do not re-add it.)
//
// `transport: "iu-openai"` marks the three routes (`adversary`, `read_image`, `read_drawing`)
// that never reach `runSession` at all — a direct IU OpenAI transport call consuming only
// `.model`. Their `backend`/`fallback` are informational defaults only; a
// `SIDECLAW_BACKEND_<TOOL>` override on one of them is refused rather than silently accepted
// and displayed with no effect.
//
// Env overrides, read once at module load (a flip needs `make reload`; the MCP process
// loads sideclaw/.env itself — see server/lib/load-env.ts):
//   SIDECLAW_MODEL_<TOOL>=<id>        e.g. SIDECLAW_MODEL_CHECK=claude-haiku-4-5
//   SIDECLAW_BACKEND_<TOOL>=iu|max    e.g. SIDECLAW_BACKEND_REVIEW=iu
// <TOOL> is the route key upper-cased. A `max` override on a non-Claude id is refused
// back to `iu` (logged via `overrides`) — Max never serves a gateway model. The effective
// override list (applied + refused) is logged once at startup via `logRoutingOverrides`.

export type Backend = "iu" | "max";

export const ROUTED_TOOLS = [
  "check",
  "overview",
  "review_router",
  "narrative",
  "review",
  "adversary",
  "dispatch",
  "otel",
  "excalidraw",
  "read_image",
  "read_drawing",
] as const;
export type RoutedTool = (typeof ROUTED_TOOLS)[number];

export interface RouteFallback {
  backend: Backend;
  /** Model to run the fallback attempt on. Absent → the primary model (only valid when
   *  the primary is a Claude id, which both backends serve). */
  model?: string;
}

export interface ToolRoute {
  model: string;
  backend: Backend;
  fallback: RouteFallback | null;
  /** "session" (default): `runSession()` actually honors `backend`/`fallback`.
   *  "iu-openai": a direct IU OpenAI transport call (adversary, read_image,
   *  read_drawing) that only ever consumes `.model` — see the module comment above. */
  transport: "session" | "iu-openai";
}

export const SONNET = "claude-sonnet-5[1m]";
export const HAIKU = "claude-haiku-4-5";
export const GLM_FLASH = "glm-5.3-flash";

// ── Tiers — named once, referenced by every tool that shares the shape, so a re-tiering
// touches one line instead of hunting down every duplicate. ──────────────────────────
//
// CLASSIFY: cheap mechanical work (check, overview, review's triage router) — glm-5.3-flash
//   over IU with Haiku-on-Max as the reverse lane.
// AGENT: dispatch ONLY — owner decision 2026-09-11 (formerly a `SIDECLAW_MODEL_DISPATCH`
//   override in `.env`; moved here so the default and the decision are the same place)
//   to run dispatch's agentic worker episodes on glm-5.3-flash over IU, same model
//   CLASSIFY already trusts: ccbench (modelpick, 2026-09-11) scored it 10/10 on the
//   agentic coding suite at $0.048/suite, ahead of claude-sonnet-5 on DeepSWE (0.634 vs
//   0.538) and leading the Anthropic-route field on the AA coding index. GLM dispatch
//   episodes have been measured completing fine. claude-sonnet-5[1m] on Max is the
//   reactive fallback — this is what moves dispatch off the Max subscription onto
//   metered IU. Deliberately NOT extended to review or otel — see JUDGE below.
// JUDGE: judgment-heavy work that stays on Max — review (angles/synthesis/router) and
//   otel. Both excluded from AGENT, for different reasons, both dated 2026-09-11:
//     - review: measured the same day with `SIDECLAW_MODEL_REVIEW=glm-5.3-flash`, a
//       ~1000-line diff's senior-dev angle looped a single grep/sed for 17 minutes at
//       80,000+ turns and never produced a synthesis — cancelled, route reverted. Multi-
//       angle review over a large diff is a different workload shape from the 10-task
//       coding suite AGENT's evidence came from, and it is the one tool where the cheap
//       tier has actually been measured failing. A non-Claude model here would also drop
//       the Max fallback entirely (Max only serves Claude ids), leaving a failing review
//       with nowhere to go.
//     - otel: sideclaw's one synchronous exception — it runs inline and returns to the
//       caller instead of going through the job queue, so a worker that loops there
//       blocks a human's interactive session, not a background ledger item. Never
//       measured on a cheap model; the owner's rule is that attended/interactive work
//       stays on Max (a flat subscription, free at the margin). No reason to gamble it.
//   Do not "fix" this inconsistency with AGENT without new measured evidence.
// PROSE: editorial/generative work (narrative, excalidraw) — re-tiered 2026-09-11 the
//   other way: same model (claude-sonnet-5[1m]), but anchored on Max (a flat fee) instead
//   of paying IU per-token for it — the one metered-premium lane worth eliminating, since
//   Sonnet isn't the ccbench-winning model AGENT moved to. IU is the reverse fallback.
//   gpt-5.6-luna was considered and rejected: the IU Anthropic route (`/anthropic/v1/
//   messages`) that runSession requires 404s on it (checked 2026-09-11) — runSession
//   spawns Claude Code, which speaks only the Anthropic protocol, so a model absent from
//   that route can never be reached through it regardless of what the gateway serves
//   elsewhere.
// VISION: the IU OpenAI vision transport (read_image, read_drawing) — no runSession, no
//   fallback.
// adversary sits alone: its own model (gpt-5.6-terra), same iu-openai transport as VISION.
const CLASSIFY: ToolRoute = {
  model: GLM_FLASH,
  backend: "iu",
  fallback: { backend: "max", model: HAIKU },
  transport: "session",
};
const AGENT: ToolRoute = {
  model: GLM_FLASH,
  backend: "iu",
  fallback: { backend: "max", model: SONNET },
  transport: "session",
};
const JUDGE: ToolRoute = {
  model: SONNET,
  backend: "max",
  fallback: { backend: "iu" },
  transport: "session",
};
const PROSE: ToolRoute = {
  model: SONNET,
  backend: "max",
  fallback: { backend: "iu" },
  transport: "session",
};
const VISION: ToolRoute = {
  model: "gemini-3.5-flash",
  backend: "iu",
  fallback: null,
  transport: "iu-openai",
};

const DEFAULT_ROUTES: Record<RoutedTool, ToolRoute> = {
  check: CLASSIFY,
  overview: CLASSIFY,
  review_router: CLASSIFY,
  narrative: PROSE,
  review: JUDGE,
  adversary: { model: "gpt-5.6-terra", backend: "iu", fallback: null, transport: "iu-openai" },
  dispatch: AGENT,
  otel: JUDGE,
  excalidraw: PROSE,
  read_image: VISION,
  read_drawing: VISION,
};

export function isClaudeModel(model: string): boolean {
  return model.startsWith("claude");
}

export interface RoutingOverride {
  tool: RoutedTool;
  field: "model" | "backend";
  value: string;
  /** Set when the override was refused (a `max` backend on a non-Claude id, or an
   *  unknown backend name); the default stayed in force. */
  refused?: string;
  /** Set when no env var named this field — it changed as a side effect of another
   *  override (a gateway model id forcing a `max` route onto `iu`). */
  implied?: string;
}

export interface RoutingTable {
  routes: Record<RoutedTool, ToolRoute>;
  overrides: RoutingOverride[];
}

/** Pure: defaults + env overrides → the effective table. Exported for tests; the module
 *  singleton below is built once from `process.env`. */
export function buildRoutingTable(env: Record<string, string | undefined>): RoutingTable {
  const routes = {} as Record<RoutedTool, ToolRoute>;
  const overrides: RoutingOverride[] = [];
  for (const tool of ROUTED_TOOLS) {
    const base = DEFAULT_ROUTES[tool];
    let { model, backend } = base;
    const key = tool.toUpperCase();
    const modelOverride = env[`SIDECLAW_MODEL_${key}`]?.trim();
    if (modelOverride) {
      model = modelOverride;
      overrides.push({ tool, field: "model", value: modelOverride });
    }
    const backendOverride = env[`SIDECLAW_BACKEND_${key}`]?.trim();
    if (backendOverride) {
      if (base.transport === "iu-openai") {
        overrides.push({
          tool,
          field: "backend",
          value: backendOverride,
          refused: `${tool} runs over a fixed iu-openai transport (a direct fetch, not runSession) — a backend override has no effect`,
        });
      } else if (backendOverride !== "iu" && backendOverride !== "max") {
        overrides.push({
          tool,
          field: "backend",
          value: backendOverride,
          refused: `unknown backend — expected "iu" or "max"`,
        });
      } else if (backendOverride === "max" && !isClaudeModel(model)) {
        overrides.push({
          tool,
          field: "backend",
          value: backendOverride,
          refused: `max only serves Claude ids, not ${model}`,
        });
      } else {
        backend = backendOverride;
        overrides.push({ tool, field: "backend", value: backendOverride });
      }
    }
    // A model override can invalidate the default backend the same way — recorded, since
    // moving review/dispatch off Max onto metered IU is that override's largest side effect.
    if (backend === "max" && !isClaudeModel(model)) {
      backend = "iu";
      overrides.push({
        tool,
        field: "backend",
        value: "iu",
        implied: `forced by the ${model} model override — max only serves Claude ids`,
      });
    }
    routes[tool] = {
      model,
      backend,
      fallback: usableFallback(base.fallback, model, backend),
      transport: base.transport,
    };
  }
  return { routes, overrides };
}

/** A fallback is only kept when it actually moves somewhere Max can serve: not the
 *  primary's own backend, and never a gateway id onto `max` without a fixed Claude
 *  fallback model. */
function usableFallback(
  fallback: RouteFallback | null,
  model: string,
  backend: Backend,
): RouteFallback | null {
  if (!fallback || fallback.backend === backend) return null;
  const fallbackModel = fallback.model ?? model;
  if (fallback.backend === "max" && !isClaudeModel(fallbackModel)) return null;
  return fallback;
}

const TABLE = buildRoutingTable(process.env);

export function routingTable(): RoutingTable {
  return TABLE;
}

/** The effective route for a tool. Always a fresh object — callers may override `model`. */
export function routeFor(tool: RoutedTool): ToolRoute {
  const r = TABLE.routes[tool];
  return {
    model: r.model,
    backend: r.backend,
    fallback: r.fallback ? { ...r.fallback } : null,
    transport: r.transport,
  };
}

/** A route with a per-call model override (a job's `model` param). The backend is kept
 *  unless the override is a gateway id, which Max cannot serve. */
export function withModel(route: ToolRoute, model: string | undefined): ToolRoute {
  if (!model || model === route.model) return route;
  const backend: Backend = route.backend === "max" && !isClaudeModel(model) ? "iu" : route.backend;
  // A Claude override also becomes the fallback model (both backends serve it — quality
  // stays constant across the hop, only billing moves); a gateway override keeps a
  // fixed-model fallback (check's Haiku) as declared, since it cannot run on Max itself.
  const declared =
    route.fallback && isClaudeModel(model) ? { backend: route.fallback.backend } : route.fallback;
  return {
    model,
    backend,
    fallback: usableFallback(declared, model, backend),
    transport: route.transport,
  };
}

/** One-line human rendering for tool descriptions and logs: `glm-5.3-flash on iu (fallback claude-haiku-4-5 on max)`. */
export function describeRoute(route: ToolRoute): string {
  const fb = route.fallback
    ? ` (fallback ${route.fallback.model ?? route.model} on ${route.fallback.backend})`
    : "";
  return `${route.model} on ${route.backend}${fb}`;
}

/** Log the effective override list once at startup — `warn` if any override was refused
 *  (a typo'd `.env` entry, most likely), `info` otherwise. No-op when there are no
 *  overrides at all, so a clean install stays quiet. Each entrypoint calls this with its
 *  own logger AFTER `setProcessKind` so the log line is tagged with the right `source`
 *  (routing.ts's own module-load timing runs before an entrypoint's `setProcessKind` call —
 *  see process-context.ts — so this is deliberately NOT called at module load here).
 *
 *  `overrides` defaults to the real module singleton (`TABLE.overrides`) for both real
 *  entrypoints; the param exists so tests can drive all three log branches (none /
 *  refused / applied) without needing a second process to get a different `TABLE` built
 *  from different env. */
export function logRoutingOverrides(
  log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  },
  overrides: RoutingOverride[] = TABLE.overrides,
): void {
  if (overrides.length === 0) return;
  const fields = { event: "routing.overrides", overrides };
  if (overrides.some((o) => o.refused)) {
    log.warn(fields, "routing overrides applied at startup (one or more refused)");
  } else {
    log.info(fields, "routing overrides applied at startup");
  }
}

// ── Stale quota env vars ────────────────────────────────────────────────────────────
//
// SIDECLAW_MAX_QUOTA_CEILING, SIDECLAW_MAX_WEEKLY_CEILING and
// SIDECLAW_QUOTA_FILE_MAX_AGE_S fed the proactive Max-quota pre-check removed
// 2026-09-08 (see session-runner.ts's `resolveBackend` doc comment and
// docs/routing-and-quota.md) — a real `.env` still setting one of them now gets a
// silent no-op. `logRoutingOverrides` already surfaces a mistyped
// `SIDECLAW_MODEL_*`/`SIDECLAW_BACKEND_*` var the same way; this applies the same
// "warn once at startup" pattern to these three so the owner learns the fallback is
// now purely reactive instead of finding out mid-outage.
const STALE_QUOTA_ENV_VARS = [
  "SIDECLAW_MAX_QUOTA_CEILING",
  "SIDECLAW_MAX_WEEKLY_CEILING",
  "SIDECLAW_QUOTA_FILE_MAX_AGE_S",
] as const;

/** Log once at startup (`warn`) if any of the three retired quota env vars are still set.
 *  No-op otherwise. `env` defaults to `process.env`; overridable for tests. */
export function logStaleQuotaEnvVars(
  log: { warn: (obj: Record<string, unknown>, msg: string) => void },
  env: Record<string, string | undefined> = process.env,
): void {
  const set = STALE_QUOTA_ENV_VARS.filter((key) => env[key] !== undefined);
  if (set.length === 0) return;
  log.warn(
    { event: "routing.stale_env", vars: set },
    "quota env var(s) set but no longer read — the proactive Max-quota pre-check was removed " +
      "2026-09-08; the reactive max→iu fallback is now the only safeguard",
  );
}
