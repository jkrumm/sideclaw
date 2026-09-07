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
// Fallback semantics (applied in session-runner.ts, one hop only, never a second one):
//   primary `max` → `fallback.backend: "iu"`: proactive quota ceilings (`chooseBackend`)
//     plus the reactive retry on a quota-flavoured failure before first output.
//   primary `iu`  → `fallback.backend: "max"`: the reverse lane — an IU transport failure
//     (or missing IU credentials) before first output moves the attempt onto Max, on
//     `fallback.model` when set (a gateway id cannot run on Max) or the same model when not.
//
// Env overrides, read once at module load (a flip needs `make reload`; the MCP process
// loads sideclaw/.env itself — see server/lib/load-env.ts):
//   SIDECLAW_MODEL_<TOOL>=<id>        e.g. SIDECLAW_MODEL_CHECK=claude-haiku-4-5
//   SIDECLAW_BACKEND_<TOOL>=iu|max    e.g. SIDECLAW_BACKEND_REVIEW=iu
// <TOOL> is the route key upper-cased. A `max` override on a non-Claude id is refused
// back to `iu` (logged via `overrides`) — Max never serves a gateway model.

export type Backend = "iu" | "max";

export const ROUTED_TOOLS = [
  "check",
  "overview",
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
}

export const SONNET = "claude-sonnet-5[1m]";
export const HAIKU = "claude-haiku-4-5";
export const GLM_FLASH = "glm-5.3-flash";

/** The owner's tiering decision (2026-09-07). Cheap mechanical work (check, overview)
 *  runs on glm-5.3-flash over IU with Haiku-on-Max as the reverse lane; editorial work
 *  (narrative) on Sonnet over IU; judgment-heavy work (review, dispatch, otel) on Sonnet
 *  over Max with the quota fallback to IU. The adversary angle is a direct IU OpenAI
 *  text call (no runSession, no fallback); the vision tools are the IU OpenAI transport. */
const DEFAULT_ROUTES: Record<RoutedTool, ToolRoute> = {
  check: { model: GLM_FLASH, backend: "iu", fallback: { backend: "max", model: HAIKU } },
  overview: { model: GLM_FLASH, backend: "iu", fallback: { backend: "max", model: HAIKU } },
  narrative: { model: SONNET, backend: "iu", fallback: { backend: "max" } },
  review: { model: SONNET, backend: "max", fallback: { backend: "iu" } },
  adversary: { model: "gpt-5.6-terra", backend: "iu", fallback: null },
  dispatch: { model: SONNET, backend: "max", fallback: { backend: "iu" } },
  otel: { model: SONNET, backend: "max", fallback: { backend: "iu" } },
  excalidraw: { model: SONNET, backend: "iu", fallback: { backend: "max" } },
  read_image: { model: "gemini-3.5-flash", backend: "iu", fallback: null },
  read_drawing: { model: "gemini-3.5-flash", backend: "iu", fallback: null },
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
      if (backendOverride !== "iu" && backendOverride !== "max") {
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
    routes[tool] = { model, backend, fallback: usableFallback(base.fallback, model, backend) };
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
  return { model: r.model, backend: r.backend, fallback: r.fallback ? { ...r.fallback } : null };
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
  return { model, backend, fallback: usableFallback(declared, model, backend) };
}

/** One-line human rendering for tool descriptions and logs: `glm-5.3-flash on iu (fallback claude-haiku-4-5 on max)`. */
export function describeRoute(route: ToolRoute): string {
  const fb = route.fallback
    ? ` (fallback ${route.fallback.model ?? route.model} on ${route.fallback.backend})`
    : "";
  return `${route.model} on ${route.backend}${fb}`;
}
