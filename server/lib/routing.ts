// ── Tiered worker routing — the ONE place a tool's model and auth backend are decided ─────
//
// Every worker session (`runSession`) and the adversary text call pick their `{ model,
// backend, fallback }` from this table, keyed by tool. Nothing else hardcodes a model id:
// the job handlers pass `routeFor("<tool>")`, the MCP tool descriptions print the same
// route, and `GET /api/routing` exposes the effective table so an operator can see what
// a flipped env var actually did.
//
// Backends: `iu` (the IU unified endpoint's native Anthropic transport — metered per
// token, serves Claude AND gateway ids like DeepSeek-V4-Flash) and `max` (the inherited
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
//   SIDECLAW_MODEL_<TOOL>=<id>             e.g. SIDECLAW_MODEL_CHECK=claude-haiku-4-5
//   SIDECLAW_BACKEND_<TOOL>=iu|max         e.g. SIDECLAW_BACKEND_REVIEW=iu
//   SIDECLAW_THINKING_TOKENS_<TOOL>=<n>    e.g. SIDECLAW_THINKING_TOKENS_CHECK=4096
// <TOOL> is the route key upper-cased. A `max` override on a non-Claude id is refused
// back to `iu` (logged via `overrides`) — Max never serves a gateway model. A
// `SIDECLAW_THINKING_TOKENS_<TOOL>` that isn't a positive integer is refused the same way.
// The effective override list (applied + refused) is logged once at startup via
// `logRoutingOverrides`.
//
// `thinkingTokens` is a gateway model's reasoning budget on the IU leg (see
// `MAX_THINKING_TOKENS` in session-runner.ts's `buildWorkerEnv`) — `--effort`/
// `reasoning_effort`/`thinking:{type:disabled}` are all ignored by the Requesty hop, so
// this env var is the only control that reaches DeepSeek-V4-Flash (CLASSIFY, AGENT) or
// DeepSeek-V4-Pro (AGENT_IMPLEMENT) there; unset means the model's own `max` default, its worst
// setting. Only meaningful on a non-Claude route — `buildWorkerEnv` only exports it for
// one, so it is harmless (never sent) when set on a Claude route.

export type Backend = "iu" | "max";

export const ROUTED_TOOLS = [
  "check",
  "overview",
  "review_router",
  "narrative",
  "review",
  "adversary",
  "dispatch",
  "dispatch_implement",
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
  /** A gateway model's reasoning budget on the IU leg — `session-runner.ts`'s
   *  `buildWorkerEnv` exports this as `MAX_THINKING_TOKENS` for any non-Claude model, the
   *  only control that reaches DeepSeek-V4-Flash's or DeepSeek-V4-Pro's thinking depth on
   *  the Requesty hop. Absent on Claude routes (JUDGE, PROSE), which control thinking a
   *  different way, and on the `iu-openai` transport routes (VISION, adversary), which
   *  never reach `buildWorkerEnv` at all. */
  thinkingTokens?: number;
}

export const SONNET = "claude-sonnet-5[1m]";
export const HAIKU = "claude-haiku-4-5";
/** Retired from every route 2026-09-23 (see CLASSIFY below); kept as a named id so an env
 *  override naming it still resolves to something this file documents. */
export const GLM_FLASH = "glm-5.3-flash";
export const DEEPSEEK_FLASH = "DeepSeek-V4-Flash";
export const DEEPSEEK_PRO = "DeepSeek-V4-Pro";

// ── Tiers — named once, referenced by every tool that shares the shape, so a re-tiering
// touches one line instead of hunting down every duplicate. ──────────────────────────
//
// CLASSIFY: cheap mechanical work (check, overview, review's triage router) —
//   DeepSeek-V4-Flash over IU with Haiku-on-Max as the reverse lane, thinking capped at 2048
//   tokens (`thinkingTokens` — see the module-header comment on `MAX_THINKING_TOKENS`; unset
//   would run the gateway model's `max` reasoning default, its worst setting, on work that is
//   meant to be cheap).
//   2026-09-23: moved off glm-5.3-flash on the owner's instruction, which retires GLM from
//   this server entirely — the same in-loop-speed complaint the AGENT note below measured
//   (13.3 tok/s, 38m24s on ccbench's 10-task suite vs DeepSeek-V4-Flash's ~190 tok/s, 6m20s)
//   applies here too, and it is the model that stalled an 84-minute dispatch episode on
//   2026-09-15. No separate CLASSIFY-tier measurement was run: this is the same id AGENT
//   already carries, at a lower thinking budget, on strictly easier work. `GLM_FLASH` stays
//   exported as a named id so a `SIDECLAW_MODEL_<TOOL>=glm-5.3-flash` override still resolves
//   to something documented.
// AGENT: dispatch ONLY. 2026-09-11: owner decision moved dispatch off a
//   `SIDECLAW_MODEL_DISPATCH` `.env` override onto glm-5.3-flash over IU (same model
//   CLASSIFY already trusted), on ccbench scoring it 10/10 on the agentic coding suite.
//   2026-09-21: moved again, to DeepSeek-V4-Flash, on evidence measured 2026-09-20 by
//   modelpick ccbench plus a warden POC (Anthropic leg, corrected context env). The
//   owner's standing complaint with glm in this seat was in-loop speed, in both
//   interactive and dispatched use, and the numbers back it: ccbench's 10-task suite put
//   DeepSeek-V4-Flash at composite 1.00, 6m20s wall, ~190 effective in-loop tok/s, $0.09,
//   4% tool-error, zero compactions, against glm-5.3-flash's 0.81, 38m24s, 13.3 tok/s,
//   $0.035. DeepSeek-V4-Pro (the owner's first instinct) was rejected on evidence, not
//   preference: it ties Flash on every refreshed external index (AA coding index 68.8 vs
//   69.1, terminal-bench 0.787 both), runs ~3x slower and ~7x the cost in ccbench, and
//   produced one 5-minute idle stall in that run (the CLI auto-backgrounded a long Bash
//   call, then the model waited silently) — exactly the shape this lane's idle watchdog
//   turns into a verdict-less kill. The POC ran the same six read-only "decide this open
//   PR" briefs through warden→sideclaw on both: 12/12 done, no stalls, Flash 0.7–2.9 min
//   per episode vs Pro's 1.0–6.0, and Flash's verdicts matched an independent Sonnet
//   review more often — Pro waved through two PRs that review had flagged. Honest
//   caveat: on the external indices glm-5.3-flash still leads both DeepSeek V4 ids (AA
//   coding index 71.5) — this is a speed-for-a-little-capability trade, and the models
//   that beat glm on both (kimi-k3, deepseek-v4.1-flash) are OpenAI-route only,
//   unreachable from `claude -p`. claude-sonnet-5[1m] on Max stays the reactive fallback
//   — this is what moves dispatch off the Max subscription onto metered IU. Thinking
//   stays capped at 8192 tokens (`thinkingTokens`) — the budget DeepSeek-V4-Flash's
//   benchmark rows above were measured under, and still more room than a classify-shaped
//   call needs while not defaulting to a gateway model's unbounded `max`. Deliberately
//   NOT extended to review or otel — see JUDGE below.
// AGENT_IMPLEMENT: dispatch's implement tier only — investigate/author stay on AGENT.
//   2026-09-22: split off on the owner's explicit instruction, mirroring warden's own
//   `AUTO_IMPLEMENT_MODEL` (default DeepSeek-V4-Pro, warden/scripts/triage.py), which
//   already runs implement-tier episodes on Pro via a per-job model override — this makes
//   it sideclaw's own default too instead of relying on every caller to remember the
//   override. Tension noted honestly, not papered over: the 2026-09-21 measurement in the
//   AGENT comment above rejected Pro for this exact seat on evidence (ties Flash on the
//   external indices, ~3x slower and ~7x the cost in ccbench, one 5-minute idle stall, and
//   Pro waved through two PRs an independent review had flagged). This split is a policy
//   call for the higher-stakes write tier, not a new measurement overturning that one — if
//   it regresses, the fix is reverting `dispatch_implement` to AGENT, not re-litigating the
//   comment above.
const AGENT_IMPLEMENT: ToolRoute = {
  model: DEEPSEEK_PRO,
  backend: "iu",
  fallback: { backend: "max", model: SONNET },
  transport: "session",
  thinkingTokens: 8192,
};
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
  model: DEEPSEEK_FLASH,
  backend: "iu",
  fallback: { backend: "max", model: HAIKU },
  transport: "session",
  thinkingTokens: 2048,
};
const AGENT: ToolRoute = {
  model: DEEPSEEK_FLASH,
  backend: "iu",
  fallback: { backend: "max", model: SONNET },
  transport: "session",
  thinkingTokens: 8192,
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
  dispatch_implement: AGENT_IMPLEMENT,
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
  field: "model" | "backend" | "thinkingTokens";
  value: string;
  /** Set when the override was refused (a `max` backend on a non-Claude id, an
   *  unknown backend name, or a non-positive-integer thinking-token count); the default
   *  stayed in force. */
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
    let { model, backend, thinkingTokens } = base;
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
    const thinkingOverride = env[`SIDECLAW_THINKING_TOKENS_${key}`]?.trim();
    if (thinkingOverride) {
      if (base.transport === "iu-openai") {
        overrides.push({
          tool,
          field: "thinkingTokens",
          value: thinkingOverride,
          refused: `${tool} runs over a fixed iu-openai transport (a direct fetch, not runSession) — the thinking budget only applies to session transport`,
        });
      } else {
        const parsed = Number(thinkingOverride);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          overrides.push({
            tool,
            field: "thinkingTokens",
            value: thinkingOverride,
            refused: `expected a positive integer, got "${thinkingOverride}"`,
          });
        } else {
          thinkingTokens = parsed;
          overrides.push({ tool, field: "thinkingTokens", value: thinkingOverride });
        }
      }
    }
    routes[tool] = {
      model,
      backend,
      fallback: usableFallback(base.fallback, model, backend),
      transport: base.transport,
      thinkingTokens,
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
    thinkingTokens: r.thinkingTokens,
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
    // Carried over unchanged: it's a property of the tool's tier, not the model override
    // itself. Harmless when the override moves to a Claude id — buildWorkerEnv only ever
    // exports MAX_THINKING_TOKENS for a non-Claude model.
    thinkingTokens: route.thinkingTokens,
  };
}

/** One-line human rendering for tool descriptions and logs: `DeepSeek-V4-Flash on iu (fallback claude-haiku-4-5 on max)`. */
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
