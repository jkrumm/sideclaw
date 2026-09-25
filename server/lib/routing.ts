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
// Harness: `claude` (default — spawns `claude -p`, `session-runner.ts`) or `opencode`
// (spawns `opencode run`, `server/mcp/opencode-runner.ts`) — ONLY `dispatch`/
// `dispatch_implement` run on `opencode` as of 2026-09-24 (see the AGENT_OC/
// AGENT_OC_IMPLEMENT tiers below); every other tool stays on `claude`. A route's
// `variant` (opencode's `--variant`, a reasoning-effort knob) is only meaningful when
// `harness: "opencode"`. A fallback attempt (the `iu`→`max` reverse lane) ALWAYS runs the
// `claude` harness, regardless of the primary route's harness — Max only ever serves a
// Claude id via `claude -p`, so a fallback onto it can never be an opencode run. See
// `session-runner.ts`'s `resolveHarness`.
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
// `.model`. `transport: "external-iu"` marks `review_ocr`: an external CLI (`ocr`,
// alibaba/open-code-review) that talks to IU's Anthropic transport itself
// (`server/lib/ocr.ts` sets `OCR_LLM_URL`/`OCR_LLM_TOKEN` from `getIuConfig()`), so it too
// only ever consumes `.model` — there is no `runSession`/backend switch for a CLI sideclaw
// doesn't control the auth wiring of. Both transports' `backend`/`fallback` are informational
// defaults only; a `SIDECLAW_BACKEND_<TOOL>` override on either is refused rather than
// silently accepted and displayed with no effect.
//
// Env overrides, read once at module load (a flip needs `make reload`; the MCP process
// loads sideclaw/.env itself — see server/lib/load-env.ts):
//   SIDECLAW_MODEL_<TOOL>=<id>             e.g. SIDECLAW_MODEL_CHECK=claude-haiku-4-5
//   SIDECLAW_BACKEND_<TOOL>=iu|max         e.g. SIDECLAW_BACKEND_REVIEW=iu
//   SIDECLAW_THINKING_TOKENS_<TOOL>=<n>    e.g. SIDECLAW_THINKING_TOKENS_CHECK=4096
//   SIDECLAW_HARNESS_<TOOL>=claude|opencode e.g. SIDECLAW_HARNESS_DISPATCH=claude, PAIRED
//     with SIDECLAW_MODEL_DISPATCH=claude-sonnet-5[1m] — dispatch's default model
//     (deepseek-v4.1-flash) is only reachable via the opencode harness, so a bare
//     SIDECLAW_HARNESS_DISPATCH=claude with no matching model override is refused (see the
//     cross-field validation in buildRoutingTable below)
//   SIDECLAW_VARIANT_<TOOL>=<v>            e.g. SIDECLAW_VARIANT_DISPATCH=max
// <TOOL> is the route key upper-cased. A `max` override on a non-Claude id is refused
// back to `iu` (logged via `overrides`) — Max never serves a gateway model. A
// `SIDECLAW_THINKING_TOKENS_<TOOL>` that isn't a positive integer is refused the same way.
// A `SIDECLAW_HARNESS_<TOOL>` value other than `claude`/`opencode` is refused, same as an
// unknown backend name. Both harness/variant overrides are refused on a non-`session`
// transport route (iu-openai, external-iu), same reasoning as the backend/thinking-token
// overrides above — there is no `runSession` call for either to affect. AFTER every
// per-field override, `buildRoutingTable` validates the resulting model/harness COMBINATION:
// a Claude model always normalizes harness to `claude` (implied, not refused); a
// deepseek-v4.1-flash model with harness `claude` is refused back to the tool's own
// defaults (that model has no code path through `claude -p` at all). A
// `SIDECLAW_THINKING_TOKENS_<TOOL>` on a route whose (possibly just-normalized) harness is
// `opencode`, or a `SIDECLAW_VARIANT_<TOOL>` on one whose harness is `claude`, is refused —
// each knob only exists on the OTHER harness.
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

/** Which CLI a session actually spawns. `claude` → `claude -p` (session-runner.ts,
 *  the default on every route). `opencode` → `opencode run` (opencode-runner.ts) —
 *  see the module header's Harness paragraph. */
export type Harness = "claude" | "opencode";

export const ROUTED_TOOLS = [
  "check",
  "overview",
  "review_router",
  "narrative",
  "review",
  "review_ocr",
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
   *  read_drawing) that only ever consumes `.model` — see the module comment above.
   *  "external-iu": an external CLI (review_ocr's `ocr`) that talks to IU's Anthropic
   *  transport itself, consuming only `.model` — see the module comment above. */
  transport: "session" | "iu-openai" | "external-iu";
  /** A gateway model's reasoning budget on the IU leg — `session-runner.ts`'s
   *  `buildWorkerEnv` exports this as `MAX_THINKING_TOKENS` for any non-Claude model, the
   *  only control that reaches DeepSeek-V4-Flash's or DeepSeek-V4-Pro's thinking depth on
   *  the Requesty hop. Absent on Claude routes (JUDGE, PROSE), which control thinking a
   *  different way, and on the `iu-openai` transport routes (VISION, adversary), which
   *  never reach `buildWorkerEnv` at all. Meaningless on an `opencode`-harness route —
   *  opencode has no equivalent env control, only `variant` (below). */
  thinkingTokens?: number;
  /** Which CLI this route's `runSession` call actually spawns — see the module header's
   *  Harness paragraph and `Harness`'s doc comment. Defaults to `"claude"` on every tier
   *  below except AGENT_OC/AGENT_OC_IMPLEMENT. */
  harness: Harness;
  /** opencode's `--variant` — a reasoning-effort knob (`"high"`, `"max"`, `"none"`, …)
   *  specific to the model's `opencode.json` entry (see `buildOpencodeConfig` in
   *  opencode-runner.ts). Only read when `harness === "opencode"`; absent (undefined) on
   *  every `claude`-harness route, where thinking is controlled by `thinkingTokens`
   *  (gateway ids) or not at all (Claude ids). */
  variant?: string;
}

export const SONNET = "claude-sonnet-5[1m]";
export const HAIKU = "claude-haiku-4-5";
/** Retired from every route 2026-09-23 (see CLASSIFY below); kept as a named id so an env
 *  override naming it still resolves to something this file documents. */
export const GLM_FLASH = "glm-5.3-flash";
export const DEEPSEEK_FLASH = "DeepSeek-V4-Flash";
/** OpenCode-harness-only id — reached over the IU OpenAI-compatible route as
 *  `iu/deepseek-v4.1-flash` (opencode-runner.ts's `buildOpencodeConfig`/`buildOpencodeArgs`),
 *  NOT the IU native Anthropic transport `DEEPSEEK_FLASH` above runs over — `claude -p`
 *  cannot reach this id at all. See AGENT_OC below. */
export const DEEPSEEK_V41_FLASH = "deepseek-v4.1-flash";

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
// AGENT_IMPLEMENT / AGENT — RETIRED 2026-09-24, replaced by AGENT_OC / AGENT_OC_IMPLEMENT
//   below. History kept as comment text since the constants themselves are now dead code
//   (nothing references them — deleted rather than left unused):
//
//   AGENT_IMPLEMENT: dispatch's implement tier only — investigate/author stayed on AGENT.
//   2026-09-22: split off on the owner's explicit instruction, mirroring warden's own
//   `AUTO_IMPLEMENT_MODEL` (default DeepSeek-V4-Pro, warden/scripts/triage.py), which
//   already ran implement-tier episodes on Pro via a per-job model override — this made
//   it sideclaw's own default too instead of relying on every caller to remember the
//   override. Tension noted honestly, not papered over: the 2026-09-21 measurement in the
//   AGENT comment above rejected Pro for this exact seat on evidence (ties Flash on the
//   external indices, ~3x slower and ~7x the cost in ccbench, one 5-minute idle stall, and
//   Pro waved through two PRs an independent review had flagged). That split was a policy
//   call for the higher-stakes write tier, not a new measurement overturning the AGENT one.
//   { model: "DeepSeek-V4-Pro", backend: "iu", fallback: { backend: "max", model: SONNET },
//     transport: "session", thinkingTokens: 8192 } — the model id string is kept only as
//   history text here; the `DEEPSEEK_PRO` constant itself was removed 2026-09-24 (unused
//   once this tier retired — nothing else in the codebase referenced it).
//
// AGENT_OC / AGENT_OC_IMPLEMENT — dispatch (investigate/author) and dispatch_implement,
//   2026-09-24. Owner decision, moving dispatch off `claude -p` entirely onto the OpenCode
//   harness (`opencode run`, opencode-runner.ts) running `deepseek-v4.1-flash` over the IU
//   endpoint's OpenAI-compatible route (`iu/deepseek-v4.1-flash`) — a DIFFERENT id and a
//   DIFFERENT transport from AGENT's `DeepSeek-V4-Flash` over the IU native Anthropic
//   transport above; `claude -p` cannot reach this id at all, hence the new harness rather
//   than a model-only swap. Evidence: the same three implement briefs re-run from Pro's
//   (AGENT_IMPLEMENT's) base commits, OpenCode+deepseek-v4.1-flash vs DeepSeek-V4-Pro on
//   `claude -p` — vps $2.46/10min vs $0.06/5min; research-gateway #21 $11.01/28min vs
//   $0.10/5min (max effort $0.11); weatherorb $5.39/21min vs $0.06/5min. A blind diff
//   review preferred OpenCode's output on 2 of 3 (research-gateway: max effort variant
//   closed a gap Pro's diff left open, 479/0 tests; weatherorb: tied/won, did an AGENTS.md
//   update Pro skipped, 1872 tests passed) and lost one (vps: inverted volume-floor logic
//   in a HyperDX config — not a clean sweep, recorded honestly). Cache hit 95–98% on this
//   route vs V4-Pro's 8% on the Anthropic route. Gateway-measured rates for
//   deepseek-v4.1-flash: $0.15/MTok input, $0.60 output, ~$0.003 cache read (used by
//   opencode-runner.ts's cost computation, since opencode has no --json-schema envelope to
//   read a CLI-computed cost from). `variant` is opencode's reasoning-effort knob:
//   investigate/author at "high" (AGENT_OC), implement at "max" (AGENT_OC_IMPLEMENT) —
//   mirroring AGENT_IMPLEMENT's own higher-stakes-write-tier split above. Fallback stays
//   claude-sonnet-5[1m] on Max — a fallback attempt always runs the `claude` harness (see
//   the module header's Harness paragraph), so a lane switch here is model AND harness AND
//   transport all changing at once, same as it already was reaching Max from AGENT/
//   AGENT_IMPLEMENT's IU-native-Anthropic primary.
const AGENT_OC: ToolRoute = {
  model: DEEPSEEK_V41_FLASH,
  backend: "iu",
  fallback: { backend: "max", model: SONNET },
  transport: "session",
  harness: "opencode",
  variant: "high",
};
const AGENT_OC_IMPLEMENT: ToolRoute = {
  model: DEEPSEEK_V41_FLASH,
  backend: "iu",
  fallback: { backend: "max", model: SONNET },
  transport: "session",
  harness: "opencode",
  variant: "max",
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
  harness: "claude",
};
const JUDGE: ToolRoute = {
  model: SONNET,
  backend: "max",
  fallback: { backend: "iu" },
  transport: "session",
  harness: "claude",
};
const PROSE: ToolRoute = {
  model: SONNET,
  backend: "max",
  fallback: { backend: "iu" },
  transport: "session",
  harness: "claude",
};
const VISION: ToolRoute = {
  model: "gemini-3.5-flash",
  backend: "iu",
  fallback: null,
  transport: "iu-openai",
  harness: "claude",
};

const DEFAULT_ROUTES: Record<RoutedTool, ToolRoute> = {
  check: CLASSIFY,
  overview: CLASSIFY,
  review_router: CLASSIFY,
  narrative: PROSE,
  review: JUDGE,
  // review_ocr: the `ocr` CLI (server/lib/ocr.ts) only ever consumes `.model` — it is not a
  // `runSession` worker, so there is no Max lane for it to fall back to (Max serves the
  // Claude Code CLI's own auth path, not an arbitrary external binary's), same reasoning as
  // adversary/VISION below. deepseek-v4.1-flash with ocr's `--effort low` (ocr.ts) since
  // 2026-09-25, from a same-range bake-off (sideclaw 819bcc7..4898afb, 1.8k lines, every
  // finding checked by hand). Wall time in ocr is LLM rounds × ~5s per round (the same for
  // every model), not tok/s: at the default effort (2 review passes) v4.1-flash explored for
  // 117 rounds / 6m30s. With `--effort low` it ran 3× at 2m31s-3m09s with 4-7 findings,
  // nearly all real, and the most cross-file/config catches of any model — the class the
  // angle reviewers miss. Also measured: `reasoning_effort: none` 2m04s but noisier;
  // gpt-5.6-luna 3× 1m39s-1m53s, 4-6 real (overlaps the angles more); gpt-6-luna 3× ~1m30s,
  // 2-3 real (terser); gemini-3.8-flash 2× ~7m, 1-3 real (84 rounds at a 3.3s IU TTFT).
  review_ocr: {
    model: DEEPSEEK_V41_FLASH,
    backend: "iu",
    fallback: null,
    transport: "external-iu",
    harness: "claude",
  },
  adversary: {
    model: "gpt-5.6-terra",
    backend: "iu",
    fallback: null,
    transport: "iu-openai",
    harness: "claude",
  },
  dispatch: AGENT_OC,
  dispatch_implement: AGENT_OC_IMPLEMENT,
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
  field: "model" | "backend" | "thinkingTokens" | "harness" | "variant";
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
    let { model, backend, thinkingTokens, harness, variant } = base;
    const key = tool.toUpperCase();
    const modelOverride = env[`SIDECLAW_MODEL_${key}`]?.trim();
    if (modelOverride) {
      model = modelOverride;
      overrides.push({ tool, field: "model", value: modelOverride });
    }
    const backendOverride = env[`SIDECLAW_BACKEND_${key}`]?.trim();
    if (backendOverride) {
      if (base.transport !== "session") {
        overrides.push({
          tool,
          field: "backend",
          value: backendOverride,
          refused:
            base.transport === "iu-openai"
              ? `${tool} runs over a fixed iu-openai transport (a direct fetch, not runSession) — a backend override has no effect`
              : `${tool} runs over a fixed external-iu transport (an external CLI, not runSession) — a backend override has no effect`,
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
    const harnessOverride = env[`SIDECLAW_HARNESS_${key}`]?.trim();
    if (harnessOverride) {
      if (base.transport !== "session") {
        overrides.push({
          tool,
          field: "harness",
          value: harnessOverride,
          refused:
            base.transport === "iu-openai"
              ? `${tool} runs over a fixed iu-openai transport (a direct fetch, not runSession) — a harness override has no effect`
              : `${tool} runs over a fixed external-iu transport (an external CLI, not runSession) — a harness override has no effect`,
        });
      } else if (harnessOverride !== "claude" && harnessOverride !== "opencode") {
        overrides.push({
          tool,
          field: "harness",
          value: harnessOverride,
          refused: `unknown harness — expected "claude" or "opencode"`,
        });
      } else {
        harness = harnessOverride;
        overrides.push({ tool, field: "harness", value: harnessOverride });
      }
    }
    // ── Cross-field validation, AFTER model/backend/harness overrides above have all been
    // applied — every route below this point has a model/harness combination that is
    // actually reachable.
    //
    // isClaudeModel(model) always implies harness "claude": opencode's `iu` provider has no
    // code path to a Claude id at all (see withModel's doc comment). Normalize + report as
    // IMPLIED, not refused — the model override (or default) is legitimate, harness just has
    // to follow it.
    if (isClaudeModel(model) && harness !== "claude") {
      harness = "claude";
      variant = undefined;
      overrides.push({
        tool,
        field: "harness",
        value: "claude",
        implied: `forced by the ${model} model — a Claude id can only run on the claude harness`,
      });
    }
    // The reverse: DEEPSEEK_V41_FLASH is reachable ONLY via the opencode harness (opencode's
    // `iu` provider over the OpenAI-compatible route) — `claude -p` has no path to it at all.
    // If the overrides above land on this combination, REFUSE whichever override actually
    // caused it and fall back to the tool's own documented default for BOTH fields — a
    // partial revert would leave the other field pointing at a combination nothing declared.
    // Session transport only: an external-iu route (review_ocr's `ocr` CLI) never runs a
    // harness, so it may carry this id with the inert default harness.
    if (base.transport === "session" && model === DEEPSEEK_V41_FLASH && harness !== "opencode") {
      const culprit = harnessOverride ? "harness" : modelOverride ? "model" : "harness";
      const culpritValue = harnessOverride ?? modelOverride ?? harness;
      // The culprit override already pushed a plain "accepted" entry above (the harness or
      // model block's own `else` branch) — remove it rather than leaving both a plain and a
      // refused entry for the same field in the reported list.
      const acceptedIdx = overrides.findIndex(
        (o) =>
          o.tool === tool &&
          o.field === culprit &&
          o.value === culpritValue &&
          !o.refused &&
          !o.implied,
      );
      if (acceptedIdx !== -1) overrides.splice(acceptedIdx, 1);
      overrides.push({
        tool,
        field: culprit,
        value: culpritValue,
        refused:
          `${DEEPSEEK_V41_FLASH} is reachable only via the opencode harness (claude -p cannot ` +
          `run it) — pair SIDECLAW_HARNESS_${key}=claude with a SIDECLAW_MODEL_${key} override ` +
          `naming a Claude id instead`,
      });
      model = base.model;
      harness = base.harness;
      variant = base.variant;
    }
    const thinkingOverride = env[`SIDECLAW_THINKING_TOKENS_${key}`]?.trim();
    if (thinkingOverride) {
      if (base.transport !== "session") {
        overrides.push({
          tool,
          field: "thinkingTokens",
          value: thinkingOverride,
          refused:
            base.transport === "iu-openai"
              ? `${tool} runs over a fixed iu-openai transport (a direct fetch, not runSession) — the thinking budget only applies to session transport`
              : `${tool} runs over a fixed external-iu transport (an external CLI, not runSession) — the thinking budget only applies to session transport`,
        });
      } else if (harness === "opencode") {
        overrides.push({
          tool,
          field: "thinkingTokens",
          value: thinkingOverride,
          refused: `${tool} runs on the opencode harness — reasoning depth is controlled by SIDECLAW_VARIANT_${key} instead, not a thinking-token budget`,
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
    const variantOverride = env[`SIDECLAW_VARIANT_${key}`]?.trim();
    if (variantOverride) {
      if (base.transport !== "session") {
        overrides.push({
          tool,
          field: "variant",
          value: variantOverride,
          refused:
            base.transport === "iu-openai"
              ? `${tool} runs over a fixed iu-openai transport (a direct fetch, not runSession) — a variant override has no effect`
              : `${tool} runs over a fixed external-iu transport (an external CLI, not runSession) — a variant override has no effect`,
        });
      } else if (harness === "claude") {
        overrides.push({
          tool,
          field: "variant",
          value: variantOverride,
          refused: `${tool} runs on the claude harness — variant is an opencode-only reasoning-effort knob`,
        });
      } else {
        variant = variantOverride;
        overrides.push({ tool, field: "variant", value: variantOverride });
      }
    }
    routes[tool] = {
      model,
      backend,
      fallback: usableFallback(base.fallback, model, backend),
      transport: base.transport,
      thinkingTokens,
      harness,
      variant,
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
    harness: r.harness,
    variant: r.variant,
  };
}

/** A route with a per-call model override (a job's `model` param). The backend is kept
 *  unless the override is a gateway id, which Max cannot serve.
 *
 *  A Claude id ALWAYS forces `harness: "claude"` — a per-job model override naming a
 *  Claude id (e.g. warden's `AUTO_IMPLEMENT_MODEL` pointed at `claude-*`) must still run
 *  `claude -p`, since opencode's harness has no code path to a Claude id (its `iu` provider
 *  is wired to the OpenAI-compatible route only — see opencode-runner.ts). A non-Claude
 *  override, conversely, keeps the route's OWN harness unchanged: overriding AGENT_OC's
 *  model to a different gateway id does not silently opt it into `claude -p`. `variant` is
 *  dropped (undefined) once forced onto `claude` — opencode's reasoning-effort knob is
 *  meaningless there. */
export function withModel(route: ToolRoute, model: string | undefined): ToolRoute {
  if (!model || model === route.model) return route;
  const backend: Backend = route.backend === "max" && !isClaudeModel(model) ? "iu" : route.backend;
  const harness: Harness = isClaudeModel(model) ? "claude" : route.harness;
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
    harness,
    variant: harness === "opencode" ? route.variant : undefined,
  };
}

/** One-line human rendering for tool descriptions and logs: `DeepSeek-V4-Flash on iu (fallback claude-haiku-4-5 on max)`,
 *  or, for an opencode-harness route, `deepseek-v4.1-flash on iu via opencode (variant high) (fallback claude-sonnet-5[1m] on max)`. */
export function describeRoute(route: ToolRoute): string {
  const harnessPart =
    route.harness === "opencode"
      ? ` via opencode${route.variant ? ` (variant ${route.variant})` : ""}`
      : "";
  const fb = route.fallback
    ? ` (fallback ${route.fallback.model ?? route.model} on ${route.fallback.backend})`
    : "";
  return `${route.model} on ${route.backend}${harnessPart}${fb}`;
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
