// ── Dispatch repo policy — which repo, and which tier, `dispatch` may run in ──────────────
//
// `POST /api/jobs` with `{ tool: "dispatch" }` has no auth, no repo allowlist and no tier
// ceiling of its own — `runDispatch` (server/jobs/handlers/dispatch.ts) only ever checked
// that `cwd` existed and had a `.git`. This module is the boundary that was missing: a
// frozen default table of per-repo rules, a pure env-override builder (same pattern as
// server/lib/routing.ts — a `const` default, a `build*(env)` function exported for tests,
// a startup log, a read-only HTTP projection), and `resolveDispatchTarget`, the one function
// both the job route and the job handler call before anything else runs.
//
// `sensitive` used to be a field the CALLER declared (`sensitive: z.boolean().default(false)`
// on `DISPATCH_INPUT`) and sideclaw never verified — an unauthenticated submitter could omit
// it and run `tier: "implement"` inside a secret-bearing repo. `resolveDispatchTarget`
// derives `sensitive` from this policy instead; the handler ORs it with whatever the caller
// still declares, so a caller MAY opt a repo the policy does not mark into the scan, but can
// never opt one the policy does mark OUT of it.
//
// ── WHAT THIS IS NOT ───────────────────────────────────────────────────────────────────────
// It is a policy boundary on WHICH repo and WHICH tier — not a sandbox. Once `resolveDispatchTarget`
// admits an episode, the worker session still has an unrestricted `Bash` under
// `--dangerously-skip-permissions`, and nothing here constrains what that session can do
// inside the repo it was let into. See `server/jobs/handlers/dispatch-git.ts:155-170` for the
// full argument (the `GIT_DENY_CREDENTIALS_ENV` header comment) — the same "raises the cost
// of an accident, does not contain an adversary" framing applies here.
//
// Also NOT: a config file. sideclaw deliberately has none — the `const` default + env
// override shape is the house pattern (routing.ts), not a one-off.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { WORKSPACE_ROOTS } from "./workspace.ts";

// The single source of truth for the tier list. `DISPATCH_INPUT`'s zod enum in
// server/jobs/handlers/dispatch.ts is built FROM this array and re-exports the type, so a
// tier added in one place cannot silently fail to exist in the other — which matters here
// specifically because `tierRank`'s fail-closed `?? 99` would mask exactly that drift by
// refusing the new tier everywhere instead of reporting it at compile time.
export const DISPATCH_TIERS = ["investigate", "author", "implement"] as const;
export type DispatchTier = (typeof DISPATCH_TIERS)[number];

/** The tier a submission that names none is checked at. `DISPATCH_INPUT`'s zod `.default()`
 *  and the route's pre-check both read THIS — two "belt and suspenders" checks that disagree
 *  about which tier an omitting call gets are not belt and suspenders, they are a gap. */
export const DEFAULT_DISPATCH_TIER: DispatchTier = "investigate";

export interface RepoRule {
  ceiling: DispatchTier;
  sensitive: boolean;
}

// Ordered so a higher rank is a MORE permissive tier. An unrecognized tier string ranks
// above `implement` (99, mirroring hermes-cc.sh's `tier_rank`) so a typo or an unknown value
// fails closed — refused as exceeding every real ceiling, never silently permitted.
const TIER_RANK: Record<DispatchTier, number> = {
  investigate: 0,
  author: 1,
  implement: 2,
};

function tierRank(tier: string): number {
  return TIER_RANK[tier as DispatchTier] ?? 99;
}

/** The rule for any repo with no entry in `DEFAULT_RULES`/`PINNED_RULES` — full reach,
 *  policy-neutral. Named so a caller can see the fallback without re-deriving it. */
export const DEFAULT_RULE: RepoRule = { ceiling: "implement", sensitive: false };

// Un-overridable. `sideclaw` is the executor itself and `warden` is the control plane that
// drives it — letting either be `implement`-reachable through its own dispatch surface closes
// a loop with no outside observer left to catch a bad episode. Env can LOWER a ceiling
// (SIDECLAW_DISPATCH_CEILINGS) or ADD sensitivity (SIDECLAW_DISPATCH_SENSITIVE) for any other
// repo, but never for these two: an attempt to raise, remove, or otherwise touch a pinned
// entry is refused and logged, never applied — see applyCeilingOverrides/
// applySensitiveOverrides below, and note PINNED_RULES is merged into the table LAST in
// buildDispatchPolicy so it always wins regardless of what ran before it.
const PINNED_RULES: Record<string, RepoRule> = Object.freeze({
  sideclaw: { ceiling: "investigate", sensitive: false },
  warden: { ceiling: "investigate", sensitive: false },
});

// Overridable, but only in the stricter direction. Mirrors
// ~/SourceRoot/hermes-agent/config/dispatch-repos.json, which is the policy this re-asserts
// at the sideclaw boundary rather than trusting Hermes to be the only caller that ever exists.
const DEFAULT_RULES: Record<string, RepoRule> = Object.freeze({
  "dotfiles-private": { ceiling: "investigate", sensitive: true },
  "homelab-private": { ceiling: "investigate", sensitive: true },
  dotfiles: { ceiling: "investigate", sensitive: false },
  brain: { ceiling: "investigate", sensitive: false },
  "hermes-agent": { ceiling: "investigate", sensitive: false },
});

export interface PolicyOverride {
  key: string;
  value: string;
  applied: boolean;
  reason?: string;
}

export interface DispatchPolicy {
  roots: string[];
  rules: Record<string, RepoRule>;
  overrides: PolicyOverride[];
}

/** `SIDECLAW_DISPATCH_ROOTS` — comma-separated absolute paths, default `WORKSPACE_ROOTS`. A
 *  non-absolute entry is refused (and logged) individually; the rest still apply. If every
 *  entry is refused, the default roots are kept rather than left empty. */
function buildRoots(
  env: Record<string, string | undefined>,
  overrides: PolicyOverride[],
): string[] {
  const raw = env.SIDECLAW_DISPATCH_ROOTS?.trim();
  if (!raw) return WORKSPACE_ROOTS;

  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const applied: string[] = [];
  for (const entry of entries) {
    if (!isAbsolute(entry)) {
      overrides.push({
        key: "SIDECLAW_DISPATCH_ROOTS",
        value: entry,
        applied: false,
        reason: `not an absolute path: ${entry}`,
      });
      continue;
    }
    applied.push(entry);
    overrides.push({ key: "SIDECLAW_DISPATCH_ROOTS", value: entry, applied: true });
  }
  if (applied.length === 0) {
    overrides.push({
      key: "SIDECLAW_DISPATCH_ROOTS",
      value: raw,
      applied: false,
      reason: "no absolute paths remained after filtering — kept the default roots",
    });
    return WORKSPACE_ROOTS;
  }
  return applied;
}

/** `SIDECLAW_DISPATCH_CEILINGS=repo:tier,repo:tier` — applied ONLY when it lowers the
 *  effective ceiling for that repo. Raising (or leaving it unchanged) is refused and logged;
 *  so is any entry naming a `PINNED_RULES` repo, or an unknown tier name. This is the whole
 *  security value of the env surface — an override can only ever narrow what dispatch is
 *  allowed to do to a repo, never widen it. */
function applyCeilingOverrides(
  env: Record<string, string | undefined>,
  rules: Record<string, RepoRule>,
  overrides: PolicyOverride[],
): void {
  const raw = env.SIDECLAW_DISPATCH_CEILINGS?.trim();
  if (!raw) return;

  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const entry of entries) {
    const [repoRaw, tierRaw] = entry.split(":").map((s) => s?.trim());
    const key = "SIDECLAW_DISPATCH_CEILINGS";
    if (!repoRaw || !tierRaw) {
      overrides.push({
        key,
        value: entry,
        applied: false,
        reason: `malformed entry, expected repo:tier: ${entry}`,
      });
      continue;
    }
    // Normalized and own-property-checked for the same two reasons `lookupRule` is — the
    // table is keyed lowercase, and `in` walks the prototype chain.
    const repo = repoRaw.toLowerCase();
    if (Object.hasOwn(PINNED_RULES, repo)) {
      overrides.push({
        key,
        value: entry,
        applied: false,
        reason: `'${repoRaw}' ceiling is pinned and cannot be overridden by env`,
      });
      continue;
    }
    if (tierRank(tierRaw) === 99) {
      overrides.push({ key, value: entry, applied: false, reason: `unknown tier '${tierRaw}'` });
      continue;
    }
    const tier = tierRaw as DispatchTier;
    const current = lookupRule(rules, repo);
    if (tierRank(tier) >= tierRank(current.ceiling)) {
      overrides.push({
        key,
        value: entry,
        applied: false,
        reason: `'${tier}' does not lower '${repoRaw}''s ceiling of '${current.ceiling}' — raising a ceiling via env is refused`,
      });
      continue;
    }
    rules[repo] = { ceiling: tier, sensitive: current.sensitive };
    overrides.push({ key, value: entry, applied: true });
  }
}

/** `SIDECLAW_DISPATCH_SENSITIVE=repo,repo` — adds only. There is no syntax to un-mark a repo
 *  sensitive; an entry naming an already-sensitive repo is a no-op recorded as applied. An
 *  entry naming a `PINNED_RULES` repo is refused, same reasoning as the ceiling override:
 *  PINNED_RULES is merged in last regardless, so silently accepting it here would report
 *  `applied: true` for a change the merge below immediately discards. */
function applySensitiveOverrides(
  env: Record<string, string | undefined>,
  rules: Record<string, RepoRule>,
  overrides: PolicyOverride[],
): void {
  const raw = env.SIDECLAW_DISPATCH_SENSITIVE?.trim();
  if (!raw) return;

  const key = "SIDECLAW_DISPATCH_SENSITIVE";
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const entry of entries) {
    const repo = entry.toLowerCase();
    if (Object.hasOwn(PINNED_RULES, repo)) {
      overrides.push({
        key,
        value: entry,
        applied: false,
        reason: `'${entry}' is pinned and its sensitivity cannot be overridden by env`,
      });
      continue;
    }
    const current = lookupRule(rules, repo);
    // Marking a repo sensitive CLAMPS its ceiling to `investigate` rather than leaving the two
    // to be set independently. `sensitive` already means "investigate only" everywhere else in
    // this estate — hermes-cc.sh derives exactly that from the repo name, and
    // `assertSensitiveTierAllowed` refuses any higher tier outright. Without the clamp, an
    // operator who sets SENSITIVE and forgets to narrow the ceiling gets a submission admitted
    // by the route's ceiling-only pre-check, a job row and a queue slot spent, and the refusal
    // only later inside runDispatch — which contradicts this module's whole point of refusing
    // before it costs anything.
    const clamped: DispatchTier =
      tierRank(current.ceiling) > tierRank("investigate") ? "investigate" : current.ceiling;
    rules[repo] = { ceiling: clamped, sensitive: true };
    overrides.push({ key, value: entry, applied: true });
  }
}

/** Pure: defaults + env overrides → the effective policy. Exported for tests; the module
 *  singleton below is built once from `process.env`. */
export function buildDispatchPolicy(env: Record<string, string | undefined>): DispatchPolicy {
  const overrides: PolicyOverride[] = [];
  const roots = buildRoots(env, overrides);

  // `Object.create(null)`, not `{}`, and this is load-bearing rather than defensive style.
  // The appliers below write `rules[repo] = ...` with `repo` coming from config text. On a
  // plain object literal, `rules["__proto__"] = x` does NOT create an own property — it runs
  // the inherited setter and REASSIGNS the object's prototype, so the entry vanishes while
  // being reported `applied: true`. Reads go through `lookupRule`'s `Object.hasOwn`, so that
  // is contained today; it stops being contained the moment anything reads `rules[repo]`
  // directly, which is exactly the escalation this module exists to close. A null-prototype
  // object has no such setter and no inherited keys to collide with at all.
  const rules: Record<string, RepoRule> = Object.create(null);
  for (const [repo, rule] of Object.entries(DEFAULT_RULES)) {
    rules[repo] = { ...rule };
  }
  applyCeilingOverrides(env, rules, overrides);
  applySensitiveOverrides(env, rules, overrides);
  // Merged in LAST, unconditionally — so a pinned entry always wins regardless of what ran
  // above, and an env attempt to touch one (already refused above) can never have applied.
  for (const [repo, rule] of Object.entries(PINNED_RULES)) {
    rules[repo] = { ...rule };
  }

  return { roots, rules, overrides };
}

const POLICY = buildDispatchPolicy(process.env);

/** A defensive copy of the module singleton — mirrors `routingTable()` in routing.ts. */
export function dispatchPolicy(): DispatchPolicy {
  return {
    roots: [...POLICY.roots],
    rules: Object.fromEntries(
      Object.entries(POLICY.rules).map(([repo, rule]) => [repo, { ...rule }]),
    ),
    overrides: [...POLICY.overrides],
  };
}

/** Canonicalize a path the same way on BOTH sides of the containment test below. Applying
 *  `realpathSync` to the `cwd` but only `resolve()` to the roots is a real outage waiting for
 *  a symlinked root: on macOS `$TMPDIR` alone resolves through `/var -> /private/var`, so a
 *  root named through any such link would never equal the `dirname` of a canonicalized cwd,
 *  and EVERY dispatch would be refused with a message pointing at the repo rather than at the
 *  config. Fails closed either way — but fails closed for a reason nobody could read. A path
 *  that does not exist cannot be canonicalized, so it falls back to `resolve()`; the handler's
 *  own `existsSync` is what rejects it a few lines later. */
// Returns `null` when the path EXISTS but cannot be resolved. In practice that is a TOCTOU
// race and little else: `existsSync` follows symlinks exactly as `realpathSync` does and
// swallows the same stat failures by returning false, so an ELOOP or EACCES path has almost
// always already failed the check above and taken the `resolve()` branch. The window is real
// but narrow, and the branch is kept because closing it costs one comparison and leaving it
// open costs the guarantee below. Falling back to the literal string here is the one
// genuinely dangerous outcome: an unresolvable symlink whose raw text happens to sit under a
// root would be admitted on the string while the kernel follows it somewhere else entirely at
// execution time. A path that does not exist has nothing to canonicalize and is not a
// containment question — `resolve()` normalizes its `..` segments and the handler's own
// `existsSync` rejects it a few lines later.
function canonical(p: string): string | null {
  if (!existsSync(p)) return resolve(p);
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** Look a repo up in the rule table.
 *
 *  LOWERCASED, because the keys are lowercase while `basename(realpathSync(cwd))` returns the
 *  name as it is spelled ON DISK. Those agree today — every ruled repo is lowercase on disk,
 *  measured, and `realpathSync` does return the on-disk spelling for a case-flipped query
 *  (measured on both an APFS user volume and /private/tmp) — but the failure when they ever
 *  stop agreeing is silent and fail-OPEN: a repo whose directory gains a capital letter stops
 *  matching its own rule and falls through to `DEFAULT_RULE`, which is `implement`. Comparing
 *  case-insensitively costs nothing on a case-insensitive volume, where two repos differing
 *  only in case cannot coexist, and on a case-SENSITIVE one it errs toward applying the
 *  stricter rule to both — the direction to err in.
 *
 *  `Object.hasOwn`, not `rules[repo] ?? DEFAULT_RULE`: `repo` derives from an
 *  unauthenticated, HTTP-submitted `cwd`, and bracket access on `constructor`, `toString` or
 *  `__proto__` returns an inherited `Object.prototype` value rather than `undefined`. The
 *  `??` would never fire, `rule.ceiling` would read `undefined`, and `tierRank(undefined)` is
 *  99 — so `tierRank(tier) > 99` is FALSE and the ceiling check passes. A repo directory
 *  named after a prototype property would be admitted at any tier with `sensitive` falsy.
 *  Not reachable today because `DEFAULT_RULE` is already permissive, which is precisely why
 *  it would survive unnoticed until the day `DEFAULT_RULE` is tightened. */
function lookupRule(rules: Record<string, RepoRule>, repo: string): RepoRule {
  const key = repo.toLowerCase();
  return (Object.hasOwn(rules, key) ? rules[key] : undefined) ?? DEFAULT_RULE;
}

export type ResolveDispatchResult =
  | { ok: true; repo: string; root: string; sensitive: boolean }
  | { ok: false; reason: string };

/** The one function both the job route (server/routes/jobs.ts, at submit) and the job
 *  handler (server/jobs/handlers/dispatch.ts, in `runDispatch`) call before anything else
 *  runs. Never throws — a policy check that can throw is a policy check a caller has to wrap,
 *  and this one runs before the filesystem checks in the handler on purpose (a refused repo
 *  should cost nothing and reveal nothing about the local tree). */
export function resolveDispatchTarget(
  { cwd, tier }: { cwd: string; tier: string },
  policy: DispatchPolicy = POLICY,
): ResolveDispatchResult {
  if (!cwd || typeof cwd !== "string") {
    return { ok: false, reason: "cwd is required" };
  }

  const resolved = canonical(cwd);
  if (resolved === null) {
    return { ok: false, reason: `cwd exists but could not be resolved: ${cwd}` };
  }
  // A root that exists but will not resolve is DROPPED rather than compared literally — same
  // reasoning as `canonical` above, and dropping it only ever refuses more.
  const roots = policy.roots.map(canonical).filter((r): r is string => r !== null);
  const root = roots.find((r) => dirname(resolved) === r);
  if (!root) {
    return { ok: false, reason: `cwd is not a repo directly under a dispatch root: ${cwd}` };
  }

  const repo = basename(resolved);
  const rule = lookupRule(policy.rules, repo);
  if (tierRank(tier) > tierRank(rule.ceiling)) {
    return {
      ok: false,
      reason: `tier '${tier}' exceeds the ceiling '${rule.ceiling}' for repo '${repo}'`,
    };
  }

  return { ok: true, repo, root, sensitive: rule.sensitive };
}

/** Log every applied and refused override once at startup — one record per override (not
 *  batched, unlike `logRoutingOverrides`), on `info` for applied and `warn` for refused, so
 *  an operator scanning warn-level logs sees exactly the env entries that did nothing. No-op
 *  when there are no overrides at all, so a clean install stays quiet. `overrides` defaults
 *  to the real module singleton's list for both real entrypoints; the param exists so tests
 *  can drive this without a second process building a different `POLICY` from different env. */
export function logDispatchPolicy(
  log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  },
  overrides: PolicyOverride[] = POLICY.overrides,
): void {
  for (const o of overrides) {
    if (o.applied) {
      log.info(
        { event: "dispatch_policy.override_applied", ...o },
        `dispatch policy override applied: ${o.key}=${o.value}`,
      );
    } else {
      log.warn(
        { event: "dispatch_policy.override_refused", ...o },
        `dispatch policy override refused: ${o.key}=${o.value}${o.reason ? ` (${o.reason})` : ""}`,
      );
    }
  }
}
