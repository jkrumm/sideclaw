import { existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import { runSession, zodValidator } from "../../mcp/session-runner.ts";
import { routeFor } from "../../lib/routing.ts";
import { textComplete } from "../../lib/iu-openai.ts";
import type { ProgressSink } from "../store.ts";
import { appLogger as logger } from "../../logger.ts";
import { parseParams } from "./util.ts";
import {
  createReadWorktree,
  removeWorktree,
  resolveRepoIdentity,
  type DispatchWorktree,
  type RepoIdentity,
} from "./dispatch-git.ts";

// Max angle sessions in flight at once. Capping keeps concurrent claude-sonnet-5
// sessions against the IU unified endpoint from tripping its rate limits when
// 4–6 angles fire together.
const ANGLE_CONCURRENCY = 3;

// Hard cap on total angles per review. Floor angles (architect, senior-dev, +
// file-type matches) are kept first; the router's extra angles fill remaining
// slots. Bounds cost and wall time (more angles = more concurrency waves).
const MAX_ANGLES = 8;

// Appended to every angle prompt when the research-gateway is configured
// (RESEARCH_GATEWAY_URL + RESEARCH_GATEWAY_TOKEN in env). Lets a read-only angle
// worker validate an external library/API/version claim before filing it, via a
// bounded curl to the async bearer gateway. Empty string when unconfigured, so
// review still runs fully without it.
const RESEARCH_VALIDATION_BLOCK = `

## Validating external facts (optional, use sparingly)

You may verify an external technical fact against the research gateway — but ONLY when you
are about to file a finding that hinges on something you are genuinely unsure of: whether a
library API / method / option exists, its current version, or a framework's current best
practice. Do NOT use it for logic, style, or design findings about the diff itself, and do
NOT use it to "explore" the topic. At most once or twice for this entire review.

The gateway is an async bearer HTTP service. Submit a quick-depth query, then poll a few
times; if it has not answered within ~30s, drop the check and file your finding with an
explicit confidence caveat. NEVER block the review waiting on it.

\`\`\`bash
JOB=$(curl -sS --max-time 20 -X POST "$RESEARCH_GATEWAY_URL/research" \\
  -H "Authorization: Bearer $RESEARCH_GATEWAY_TOKEN" -H "Content-Type: application/json" \\
  -d '{"query":"<your one specific question>","depth":"quick"}' | jq -r '.jobId')
for i in $(seq 1 6); do
  sleep 5
  R=$(curl -sS --max-time 20 "$RESEARCH_GATEWAY_URL/research/$JOB" \\
    -H "Authorization: Bearer $RESEARCH_GATEWAY_TOKEN")
  [ "$(printf '%s' "$R" | jq -r '.status')" = "done" ] && printf '%s' "$R" | jq -r '.result.report' && break
done
\`\`\`

Use the returned report only to confirm or correct the finding before you file it. This is
the only network call you may make; stay read-only otherwise.`;

// Hardening suffix appended to the synthesis prompt on a retry, after a first
// attempt returned prose instead of the schema JSON (the failure that otherwise
// discarded the whole multi-angle run).
const SYNTHESIS_JSON_ONLY_RETRY = `

────────────────────────────────────────────────────────
RETRY — your previous response was REJECTED because it was not valid JSON. Return ONLY the
JSON object specified above. Your entire message must be a single JSON object (optionally
wrapped in one \`\`\`json fence) — no preamble such as "Here's the verdict", no markdown
headings, no commentary before or after. Emit it as your final message and stop.`;

/** Run `fn` over `items` with at most `limit` in flight. Preserves input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Input schema ─────────────────────────────────────────────────────────────

export const REVIEW_INPUT = z.object({
  cwd: z
    .string()
    .describe("Absolute path to the git repo root to review. Must be an existing git repository."),
  scope: z
    .string()
    .optional()
    .describe(
      'What to review. "uncommitted" (default) = staged + unstaged changes. "head" = last commit. A commit ref like "HEAD~3" or a SHA = the range from that ref up to HEAD (i.e. the last N commits, not the single commit). An explicit range like "main..HEAD" or a file path also work. Ignored — and must be omitted — when `pr` or `branch` is set.',
    ),
  pr: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Pull request number on the repo at `cwd`'s origin remote. When set, the review runs against that PR's head commit in a throwaway read-only worktree fetched from origin — the caller's own checkout is never touched. Mutually exclusive with `branch`; `scope` must be omitted.",
    ),
  branch: z
    .string()
    .optional()
    .describe(
      "Remote branch name on `cwd`'s origin remote. When set, the review runs against that branch's tip in a throwaway read-only worktree fetched from origin — the caller's own checkout is never touched. Mutually exclusive with `pr`; `scope` must be omitted.",
    ),
  context: z
    .string()
    .optional()
    .describe(
      'Factual description of the changes\' intent (e.g. "add MCP review tool"). Helps catch goal-mismatch bugs. Omit if the diff is self-explanatory.',
    ),
  angles: z
    .array(z.string())
    .optional()
    .describe(
      "Explicit reviewer angles to run, overriding the router. Valid: architect, senior-dev, frontend, backend, typescript, qa, security, performance, concurrency, data-migration, api-contract, resilience. Baseline architect + senior-dev are always included. Omit to let the router pick based on the diff.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Optional model override for the angle and synthesis sessions only (never the router or " +
        "the adversary critic), e.g. 'claude-opus-5[1m]'. Defaults to the measured-good review " +
        "route; overriding onto a non-Claude model also drops the Max fallback entirely — Max " +
        "only ever serves Claude model ids — so a failing review on an overridden model has " +
        "nowhere to fall back to (see the JUDGE block comment in server/lib/routing.ts for the " +
        "measurement behind why review stays pinned by default).",
    ),
});

export type ReviewParams = z.infer<typeof REVIEW_INPUT>;

// ── Output schema — single source of truth ────────────────────────────────────

const FINDING = z.object({
  file: z.string().describe("Relative file path from repo root."),
  line: z.number().optional().describe("Line number, if identifiable."),
  message: z.string().describe("What the issue is, why it matters, and how to fix it."),
  angle: z
    .string()
    .describe(
      "Which reviewer caught this: architect | senior-dev | frontend | backend | typescript | qa | security | performance | concurrency | data-migration | api-contract | resilience | adversary | coderabbit | fallow",
    ),
});

export const REVIEW_OUTCOMES = ["clean", "actionable", "needs-human"] as const;

// A consumer (today: warden) pins this number and treats a mismatch as a loud refusal rather
// than a best-effort parse — same contract as DISPATCH_SCHEMA_VERSION in dispatch.ts. Bump it
// whenever a field's meaning or presence on REVIEW_OUTPUT changes.
export const REVIEW_SCHEMA_VERSION = 1;

// What the SYNTHESIS worker is shown and graded against. `schemaVersion` is deliberately not
// part of this one — it is set by the HANDLER on every return path (the clean shortcut, both
// forced-needs-human paths, and the normal synthesis path), never by the worker, the same
// split dispatch.ts draws between WORKER_OUTPUT and DISPATCH_OUTPUT.
const SYNTHESIS_OUTPUT = z.object({
  outcome: z
    .enum(REVIEW_OUTCOMES)
    .describe(
      'Review verdict. "clean" = no findings. "actionable" = items for implementation agent. "needs-human" = has discussions requiring human decision.',
    ),
  blocking: z
    .array(FINDING)
    .describe("Bugs, security issues, type errors, data loss — must fix before merging."),
  improvements: z
    .array(FINDING)
    .describe(
      "Code quality, readability, small refactors — recommended fixes the implementation agent should apply.",
    ),
  discussions: z
    .array(FINDING)
    .describe("Big refactors, architecture changes, technology choices — needs human decision."),
  testGaps: z
    .array(z.string())
    .describe("Missing test coverage, e.g. 'server/auth.ts — unit: expired token, revoked token'."),
  summary: z
    .string()
    .describe(
      "2-3 sentence assessment with outcome, key findings, and code health. E.g. 'Actionable: 1 blocking null-check, 3 improvements. Clean architecture, good separation.'",
    ),
});

type SynthesisOutput = z.infer<typeof SYNTHESIS_OUTPUT>;

export const REVIEW_OUTPUT = SYNTHESIS_OUTPUT.extend({
  schemaVersion: z
    .literal(REVIEW_SCHEMA_VERSION)
    .describe(
      "Version of this output shape. Pin this number; a mismatch means the shape moved under " +
        "you and should be a loud refusal, not a best-effort parse.",
    ),
});

const REVIEW_JSON_SCHEMA = z.toJSONSchema(SYNTHESIS_OUTPUT);

export type ReviewOutput = z.infer<typeof REVIEW_OUTPUT>;

// ── Angle session output — simpler schema for individual reviewers ─────────────

const ANGLE_FINDING = z.object({
  severity: z.enum(["blocking", "improvement", "discussion"]),
  file: z.string(),
  line: z.number().optional(),
  message: z.string(),
});

const ANGLE_OUTPUT = z.object({
  findings: z.array(ANGLE_FINDING),
});

const ANGLE_JSON_SCHEMA = z.toJSONSchema(ANGLE_OUTPUT);

type AngleOutput = z.infer<typeof ANGLE_OUTPUT>;

// ── Skill prompt loader ────────────────────────────────────────────────────────

const SKILL_DIR = join(import.meta.dir, "../../skills/review");

async function loadAnglePrompt(angle: string): Promise<string> {
  const path = join(SKILL_DIR, `${angle}.md`);
  if (!existsSync(path)) {
    throw new Error(`review angle prompt not found: ${path}`);
  }
  return Bun.file(path).text();
}

// ── Scope validation ───────────────────────────────────────────────────────────

/** Allowlist: alphanumerics, hyphens, underscores, slashes, dots, tildes, carets. */
const SAFE_SCOPE = /^[a-zA-Z0-9._/~^@{}-]+$/;

export function validateScope(scope: string): void {
  if (scope === "uncommitted" || scope === "head") return;
  if (!SAFE_SCOPE.test(scope)) {
    throw new Error(`Invalid scope — contains unsafe characters: ${scope}`);
  }
}

/** Allowlist for a caller-supplied remote branch name (the `branch` input): must start with an
 *  alphanumeric (so a leading `-` can never be read as a flag) and contain only
 *  alphanumerics/`.`/`_`/`/`/`-` after that. `branch` is spliced directly into `bash -c`
 *  commands (`git fetch … refs/heads/${branch}:…`, `git diff …`), so this is a POSITIVE list,
 *  not a blocklist — `;`, `$()`, backticks, `|`, whitespace, and every other shell
 *  metacharacter are refused simply by not being in the allowed set, the same shape
 *  `SAFE_SCOPE` uses above. `..` is rejected separately even though `.` itself is allowed
 *  (legitimate branch names carry dots, e.g. `release-1.2.3`): it's parent-traversal / git
 *  range syntax, and `branch` must always name exactly one ref. Length capped at 200 — well
 *  over any real branch name, just a ceiling against a pathological input. */
const SAFE_BRANCH_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function validateBranchRef(branch: string): void {
  if (!branch) throw new Error("branch must not be empty");
  if (branch.length > 200) {
    throw new Error(`Invalid branch — longer than 200 characters`);
  }
  if (!SAFE_BRANCH_REF.test(branch)) {
    throw new Error(`Invalid branch — contains unsafe characters: ${branch}`);
  }
  if (branch.includes("..")) {
    throw new Error(`Invalid branch — must not contain '..': ${branch}`);
  }
}

// ── Git diff helpers ───────────────────────────────────────────────────────────

// A bare commit-ish ref (e.g. "HEAD~2", a SHA, a branch) is treated as the
// range `<ref>..HEAD` — "everything from that ref up to HEAD" — which is what a
// caller passing "HEAD~3" almost always means. `git show <ref>` (the single
// commit) was a footgun: it silently reviewed one old commit instead of the
// recent work. Explicit ranges ("main..HEAD") and paths pass through unchanged.
export function scopeDiffArgs(scope: string): string {
  if (scope.includes("..")) return scope; // explicit range
  if (scope.startsWith("/") || scope.includes(".")) return `-- ${scope}`; // file path
  return `${scope} HEAD`; // bare ref → range up to HEAD
}

// Untracked (but non-ignored) files are invisible to `git diff`, which blinded
// every reviewer to newly added files. A changed file importing a brand-new
// module handed the adversary an import with no target in the diff, and it
// filed a false blocking "file missing / build break" — observed live against
// usage-tracker's then-untracked src/collectors/sideclaw-iu.ts.
//
// `git diff --no-index -- /dev/null <file>` renders each untracked file as a
// normal added-file hunk (`new file mode`, repo-relative `b/` path) so it reads
// identically to a staged addition. `git add -N` would produce the same hunks
// via plain `git diff`, but it mutates the caller's index — a read-only review
// must never touch their staging area.
//
// -z + `xargs -0` keeps paths containing spaces intact; --exclude-standard
// honours .gitignore (so node_modules and friends stay out); --no-index always
// exits 1 when it finds a difference, so stderr is dropped and the non-zero
// exit is absorbed by the surrounding `$(...)`.
//
// Untracked files belong to the "uncommitted" scope only: the "head" and
// commit-range scopes review committed history, where a new file is already
// part of the commit and splicing in working-tree files would review code the
// caller never asked about.
const UNTRACKED_DIFF =
  "git ls-files --others --exclude-standard -z | xargs -0 -I{} git diff --no-index -- /dev/null {} 2>/dev/null";

const UNTRACKED_FILES = "git ls-files --others --exclude-standard";

export function gitDiffCommand(scope: string): string {
  switch (scope) {
    case "uncommitted":
      return `diff=$(git diff --cached); [ -z "$diff" ] && diff=$(git diff); untracked=$(${UNTRACKED_DIFF}); printf '%s\\n' "$diff" "$untracked"`;
    case "head":
      return "git show HEAD";
    default:
      return `git diff ${scopeDiffArgs(scope)}`;
  }
}

function gitDiffFilesCommand(scope: string): string {
  switch (scope) {
    case "uncommitted":
      return `files=$(git diff --cached --name-only); [ -z "$files" ] && files=$(git diff --name-only); untracked=$(${UNTRACKED_FILES}); printf '%s\\n' "$files" "$untracked"`;
    case "head":
      return "git show HEAD --name-only --format=''";
    default:
      return `git diff --name-only ${scopeDiffArgs(scope)}`;
  }
}

// ── Shell helpers ──────────────────────────────────────────────────────────────

async function shell(
  cmd: string,
  cwd: string,
  timeoutMs = 30_000,
): Promise<{ stdout: string; ok: boolean }> {
  try {
    const proc = Bun.spawn(["bash", "-c", cmd], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Two-stage timeout: SIGTERM → 5s grace → SIGKILL
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      sigkillTimer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
        sigkillTimer = null;
      }, 5000);
    }, timeoutMs);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timeout);
    if (sigkillTimer) clearTimeout(sigkillTimer);

    // Merge stderr into stdout — tools like fallow/coderabbit may write findings to stderr
    const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    return { stdout: combined, ok: exitCode === 0 };
  } catch {
    return { stdout: "", ok: false };
  }
}

// ── PR/branch worktree ────────────────────────────────────────────────────────
//
// `pr`/`branch` run the review against a fetched ref in a throwaway read-only worktree
// instead of the caller's own checkout — the seam an implement episode needs, since its
// worktree is torn down after push (dispatch.ts) and nothing else can review the branch it
// produced. Reuses `createReadWorktree`/`removeWorktree` from dispatch-git.ts (generalised to
// accept an explicit checkout OID rather than always cutting from HEAD) so this is the same
// worktree lifecycle dispatch's read tiers already get, not a second implementation.

/** Diff idiom shared with dispatch's `summarizeDiff`: triple-dot, i.e. "everything on HEAD
 *  since it diverged from base" rather than a two-dot straight comparison. `--no-renames` for
 *  the same reason summarizeDiff uses it — an honest per-file diff instead of a collapsed
 *  rename row. */
function refDiffCommand(baseOid: string): string {
  return `git diff --no-renames ${baseOid}...HEAD`;
}

function refDiffFilesCommand(baseOid: string): string {
  return `git diff --no-renames --name-only ${baseOid}...HEAD`;
}

/** Fetch a PR or branch ref from `origin` into a private local ref namespaced by `jobKey` (so
 *  concurrent reviews never race each other's `FETCH_HEAD`), and resolve it to a commit OID.
 *  Runs in `cwd` — the caller's own checkout, which is never itself modified by a fetch into
 *  a ref it doesn't check out. */
async function fetchReviewHead(
  cwd: string,
  jobKey: string,
  ref: { pr?: number; branch?: string },
  onRefCreated: () => void,
): Promise<string> {
  const remoteRef = ref.pr != null ? `pull/${ref.pr}/head` : `refs/heads/${ref.branch}`;
  const localRef = `refs/sideclaw-review/${jobKey}`;
  const fetched = await shell(`git fetch --quiet origin ${remoteRef}:${localRef}`, cwd, 120_000);
  if (!fetched.ok) {
    const what = ref.pr != null ? `PR #${ref.pr}` : `branch ${ref.branch}`;
    throw new Error(`could not fetch ${what} from origin: ${fetched.stdout.trim() || "no output"}`);
  }
  // The fetch above is what actually creates `refs/sideclaw-review/<jobKey>` in the CALLER's
  // live repo. Everything after this point — the rev-parse below, `resolveReviewBase`,
  // `createReadWorktree` — can still throw, but the ref already exists by now and needs
  // cleanup regardless. Told to the caller here, at the exact moment it becomes true, rather
  // than inferred later from `worktree` existing — that inference was the gap: a throw
  // between here and `createReadWorktree` succeeding left this ref in the live repo forever.
  onRefCreated();
  const resolved = await shell(`git rev-parse --verify ${localRef}`, cwd);
  if (!resolved.ok || !resolved.stdout.trim()) {
    throw new Error(`fetched ${remoteRef} but could not resolve ${localRef}`);
  }
  return resolved.stdout.trim();
}

/** Delete the private fetch ref `fetchReviewHead` created. Best effort and idempotent — a
 *  leftover ref costs nothing but a little `.git` bloat, and cleanup must never fail a review
 *  that already ran. Called unconditionally in ref mode, whether or not the fetch itself
 *  succeeded, since a partial fetch can still have written the ref before a later step threw. */
async function cleanupReviewFetchRef(cwd: string, jobKey: string): Promise<void> {
  await shell(`git update-ref -d refs/sideclaw-review/${jobKey}`, cwd);
}

/** Resolve the repo's authoritative default-branch OID — the diff base for a `pr`/`branch`
 *  review. Goes through `resolveRepoIdentity` (dispatch-git.ts) rather than the local
 *  `origin/HEAD` symlink for the same reason dispatch's write tiers do: that symlink is a
 *  clone-time guess that's never updated, so a renamed default branch would silently resolve
 *  the wrong base. Requires a GitHub origin, same requirement `resolveRepoIdentity` already
 *  has. */
/** Refuse a GitHub-reported default branch that doesn't pass the SAME allowlist `branch`
 *  itself is checked with (`validateBranchRef`) — called before `resolveReviewBase` lets
 *  `identity.defaultBranch` anywhere near a `shell()` call. `defaultBranch` is GitHub-API-
 *  controlled, not something this process chose: anyone able to rename a repo's default
 *  branch controls this string, and it gets spliced into a `bash -c` command. Pure and
 *  synchronous — no shell, no network — so a caller can assert "refused before any shell
 *  runs" directly against it. */
export function assertSafeDefaultBranch(identity: RepoIdentity): void {
  try {
    validateBranchRef(identity.defaultBranch);
  } catch (err) {
    throw new Error(
      `refusing to use ${identity.owner}/${identity.repo}'s default branch "${identity.defaultBranch}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function resolveReviewBase(
  cwd: string,
): Promise<{ identity: RepoIdentity; baseOid: string }> {
  const identity = await resolveRepoIdentity(cwd);
  assertSafeDefaultBranch(identity);
  const fetched = await shell(`git fetch --quiet origin ${identity.defaultBranch}`, cwd, 120_000);
  if (!fetched.ok) {
    throw new Error(
      `could not fetch origin/${identity.defaultBranch}: ${fetched.stdout.trim() || "no output"}`,
    );
  }
  const resolved = await shell(`git rev-parse --verify origin/${identity.defaultBranch}`, cwd);
  if (!resolved.ok || !resolved.stdout.trim()) {
    throw new Error(`could not resolve origin/${identity.defaultBranch} after fetch`);
  }
  return { identity, baseOid: resolved.stdout.trim() };
}

export interface RefDiffResult {
  wt: DispatchWorktree;
  diff: string;
  files: string[];
}

/** Check out `headOid` in a throwaway read worktree and diff it against `baseOid` with the
 *  triple-dot idiom above. The single unit `runReview`'s ref mode and the git-fixture test
 *  both exercise — creating the worktree and reading the diff out of it. Caller owns teardown
 *  (`removeWorktree`); this never tears down what it created. */
export async function checkoutRefDiff(
  cwd: string,
  jobKey: string,
  headOid: string,
  baseOid: string,
): Promise<RefDiffResult> {
  const wt = await createReadWorktree(cwd, jobKey, headOid);
  const [diffResult, filesResult] = await Promise.all([
    shell(refDiffCommand(baseOid), wt.path, 60_000),
    shell(refDiffFilesCommand(baseOid), wt.path, 30_000),
  ]);
  return {
    wt,
    diff: diffResult.stdout,
    files: filesResult.stdout.split("\n").filter(Boolean),
  };
}

// ── Agent selection ────────────────────────────────────────────────────────────

interface AgentConfig {
  angle: string;
  label: string;
}

interface AngleResult {
  angle: string;
  findings: AngleOutput["findings"];
  failureReason?: string;
}

function selectAgents(changedFiles: string[], hasTestScript: boolean): AgentConfig[] {
  const agents: AgentConfig[] = [
    { angle: "architect", label: "Architect" },
    { angle: "senior-dev", label: "Senior Dev" },
  ];

  const hasFrontend = changedFiles.some((f) => /\.(tsx|jsx|css)$/i.test(f));
  const hasBackend = changedFiles.some(
    (f) => /\.(ts)$/i.test(f) && /(^|\/)(?:api|server)\//.test(f),
  );
  const hasTypeScript = changedFiles.some((f) => /\.(ts|tsx)$/i.test(f));

  if (hasFrontend) agents.push({ angle: "frontend", label: "Frontend Expert" });
  if (hasBackend) agents.push({ angle: "backend", label: "Backend Expert" });
  if (hasTypeScript) agents.push({ angle: "typescript", label: "TypeScript Expert" });
  if (hasTestScript) agents.push({ angle: "qa", label: "QA Engineer" });

  return agents;
}

// ── Dynamic angle routing ────────────────────────────────────────────────────────

// Router-only angles: content-driven reviewers that file extensions can't detect.
export const ROUTER_ANGLE_LABELS: Record<string, string> = {
  security: "Security Reviewer",
  performance: "Performance Reviewer",
  concurrency: "Concurrency Reviewer",
  "data-migration": "Data & Migration Reviewer",
  "api-contract": "API Contract Reviewer",
  resilience: "Resilience Reviewer",
};

// Every angle the caller may request explicitly via the `angles` input.
export const ALL_ANGLE_LABELS: Record<string, string> = {
  architect: "Architect",
  "senior-dev": "Senior Dev",
  frontend: "Frontend Expert",
  backend: "Backend Expert",
  typescript: "TypeScript Expert",
  qa: "QA Engineer",
  ...ROUTER_ANGLE_LABELS,
};

const ROUTER_OUTPUT = z.object({
  angles: z.array(z.string()),
  rationale: z.string().optional(),
});

const ROUTER_JSON_SCHEMA = z.toJSONSchema(ROUTER_OUTPUT);

/** Dedupe by angle key, preserving order, capped at `max`. */
function capAngles(agents: AgentConfig[], max: number): AgentConfig[] {
  const seen = new Set<string>();
  const out: AgentConfig[] = [];
  for (const a of agents) {
    if (seen.has(a.angle)) continue;
    seen.add(a.angle);
    out.push(a);
    if (out.length >= max) break;
  }
  return out;
}

/** Resolve an explicit caller-provided angle list. Always keeps the baseline. */
function resolveRequestedAngles(requested: string[], floor: AgentConfig[]): AgentConfig[] {
  const baseline = floor.filter((a) => a.angle === "architect" || a.angle === "senior-dev");
  const extra = requested
    .filter((a) => a in ALL_ANGLE_LABELS)
    .map((a) => ({ angle: a, label: ALL_ANGLE_LABELS[a] }));
  return capAngles([...baseline, ...extra], MAX_ANGLES);
}

/** Run the triage router (one cheap worker session) to pick content-driven angles.
 *  Returns [] on any failure — the floor still reviews, so this degrades gracefully. */
async function routeExtraAngles(
  cwd: string,
  diffCmd: string,
  bump?: (label: string) => void,
  jobId?: string,
  isCancelled?: (jobId: string) => boolean,
): Promise<AgentConfig[]> {
  let prompt: string;
  try {
    prompt = await loadAnglePrompt("router");
  } catch (err) {
    logger.error({ tool: "review", error: String(err) }, "router prompt load failed");
    return [];
  }
  prompt = prompt.replace("[GIT_DIFF_COMMAND]", `Run: \`${diffCmd}\``);

  const result = await runSession<z.infer<typeof ROUTER_OUTPUT>>({
    cwd,
    prompt,
    tool: "review:router",
    jobId,
    isCancelled,
    // No `model` override here, deliberately: this is the cheap CLASSIFY tier
    // (review_router), not the judgment work a caller's override is meant to re-route.
    // Re-pointing the router along with the angle/synthesis override would silently widen
    // what the knob does — don't "fix" this inconsistency.
    route: routeFor("review_router"),
    jsonSchema: ROUTER_JSON_SCHEMA,
    readOnly: true,
    // No `retryAfterOutput`: same CLASSIFY tier as check/overview, and glm-5.3-flash
    // defaulting to max reasoning effort reads as "stalling" when it is only slow. A
    // timeout after it already emitted its answer used to re-lane mid-job on that alone;
    // session-runner.ts's idle watchdog is the real stuck-detector now.
    settingSources: "project",
    validate: zodValidator(ROUTER_OUTPUT),
    onActivity: bump ? (p) => bump(`router: ${p.lastAction}`) : undefined,
  });

  if (!result.ok || !result.data) {
    logger.warn(
      { tool: "review", error: result.error },
      "router failed — using deterministic angles only",
    );
    return [];
  }

  const picked = result.data.angles.filter((a) => a in ROUTER_ANGLE_LABELS);
  logger.info(
    { tool: "review", routerAngles: picked, rationale: result.data.rationale },
    "router selected extra angles",
  );
  return picked.map((a) => ({ angle: a, label: ROUTER_ANGLE_LABELS[a] }));
}

// ── Adversary critic (cross-family, non-agentic) ──────────────────────────────
//
// One single HTTPS call to the IU OpenAI transport (gpt-5.6-terra) running in
// parallel with the claude-sonnet-5 angle sessions. Purpose: kill the implicit
// self-attribution bias every same-family multi-reviewer pipeline has, by
// adding one genuinely off-policy critic. Fail-soft (returns AngleResult with
// failureReason on any error so synthesis treats it like a degraded angle, not
// a pipeline crash).
//
// gpt-5.6-terra is a reasoning model, with two non-obvious wiring rules:
//
//  1. It accepts ONLY the default temperature (1) and 400s on any explicit
//     value, so no temperature is sent. The IU gateway surfaces that 400 as a
//     503, which iuFetch treats as retryable — a stray `temperature: 0` would
//     burn all three attempts and then fail soft, silently removing the
//     adversary from every review while the pipeline still looked green.
//  2. Omitting `reasoning_effort` is NOT a neutral default: it behaves as
//     "none", so the model answers with zero thinking while still billing at
//     the reasoning tier. Measured on a real 7.5K-char diff, effort drives how
//     deep the critique goes: "none"/"medium" stopped at a surface offset bug,
//     while "high" reached the subtler token-derivation bug ~50 lines further
//     in. "high" costs ~$0.08 and ~50s — and since the adversary runs in
//     parallel with the 60–120s angle phase, that latency is free. "xhigh"
//     doubled the thinking tokens without finding more.
//
// Truncated at 200K chars so a pathological huge diff can't blow the request.

const ADVERSARY_MODEL = routeFor("adversary").model;
const ADVERSARY_EFFORT = "high" as const;
const ADVERSARY_MAX_DIFF_CHARS = 200_000;

const ADVERSARY_OUTPUT = z.object({
  findings: z.array(ANGLE_FINDING),
});

/** Best-effort JSON extraction from a model response: strips ```json fences,
 *  trims, and parses. Returns null on any failure — caller decides. */
function parseJsonLoose(raw: string): unknown {
  let s = raw.trim();
  // Strip ```json ... ``` or ``` ... ``` fences if the model added them
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  // If there's still extraneous prose, slice from first { to last }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first > 0 && last > first) s = s.slice(first, last + 1);
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function runAdversaryAngle(opts: {
  diff: string;
  contextBlock: string;
  promptPath: string;
  bump?: (label: string) => void;
}): Promise<AngleResult> {
  const angle = "adversary";
  try {
    const tmpl = await Bun.file(opts.promptPath).text();
    const diffTrimmed =
      opts.diff.length > ADVERSARY_MAX_DIFF_CHARS
        ? opts.diff.slice(0, ADVERSARY_MAX_DIFF_CHARS) +
          `\n\n[diff truncated at ${ADVERSARY_MAX_DIFF_CHARS} chars]`
        : opts.diff;
    const prompt = tmpl
      .replace("[DIFF]", diffTrimmed)
      .replace("[CONTEXT_BLOCK]", opts.contextBlock || "");

    opts.bump?.("adversary: requesting");
    const result = await textComplete({
      prompt,
      model: ADVERSARY_MODEL,
      tool: "review:adversary",
      reasoningEffort: ADVERSARY_EFFORT,
      // Generous: thinking on a near-200K-char diff is far slower than the ~50s
      // a typical diff takes, and this is a single fail-soft call with no
      // wall-time cost while the angle sessions run.
      timeoutMs: 300_000,
    });
    opts.bump?.("adversary: parsing");

    const parsed = parseJsonLoose(result.text);
    if (!parsed) {
      logger.warn(
        { tool: "review", angle, sample: result.text.slice(0, 200) },
        "adversary returned unparseable JSON",
      );
      return { angle, findings: [], failureReason: "unparseable JSON output" };
    }

    const validated = ADVERSARY_OUTPUT.safeParse(parsed);
    if (!validated.success) {
      logger.warn(
        { tool: "review", angle, error: validated.error.message },
        "adversary output failed schema validation",
      );
      return { angle, findings: [], failureReason: "schema validation failed" };
    }

    logger.info(
      {
        tool: "review",
        angle,
        model: result.model,
        findings: validated.data.findings.length,
        latencyMs: result.latencyMs,
      },
      "adversary angle done",
    );
    return { angle, findings: validated.data.findings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ tool: "review", angle, error: msg }, "adversary angle failed");
    return { angle, findings: [], failureReason: msg };
  }
}

// ── Core ───────────────────────────────────────────────────────────────────────

/** Multi-angle code review pipeline: data gather → parallel angle sessions →
 *  synthesis. Returns structured findings. Throws on git-diff failure (bad
 *  scope/not a repo) or synthesis failure; no-changes and all-angles-failed are
 *  returned as valid ReviewOutput verdicts.
 *
 *  `pr`/`branch` run the ENTIRE pipeline below — data gathering, angle sessions and
 *  synthesis — inside a throwaway read-only worktree fetched from `origin`, instead of in
 *  `cwd`. That worktree is created before Phase 1 and torn down in a `finally`, which is the
 *  seam an `implement` dispatch episode needs: its own worktree is gone by the time the branch
 *  is pushed (`dispatch.ts`'s `depositBranch`), so nothing else could review that branch
 *  without this. `scope` is rejected outright when either is set — the diff is always
 *  `base...head` of the fetched ref, never a caller-chosen range. */
export async function runReview(
  rawParams: Record<string, unknown>,
  onProgress?: ProgressSink,
  jobId?: string,
  isCancelled?: (jobId: string) => boolean,
): Promise<ReviewOutput> {
  const { cwd, scope, context, angles, pr, branch, model } = parseParams(REVIEW_INPUT, rawParams);
  if (!existsSync(cwd)) throw new Error(`Directory not found: ${cwd}`);

  if (pr != null && branch != null) {
    throw new Error("review: `pr` and `branch` are mutually exclusive — pass at most one");
  }
  const refMode = pr != null || branch != null;
  if (refMode && scope != null) {
    throw new Error(
      "review: `scope` is ignored — and must be omitted — when `pr` or `branch` is set; " +
        "the diff is always base...head of the fetched ref",
    );
  }
  if (branch != null) validateBranchRef(branch);

  // Shared liveness bump across this pipeline's many sessions. Per-session turn
  // counts would clobber under parallel angles, so we keep a single monotonic
  // counter and let any session (or phase marker) refresh lastActivityAt — that's
  // what the caller's idle-time wedge signal needs. `label` shows what's live.
  let activityTurns = 0;
  const bump = (lastAction: string): void =>
    onProgress?.({ turns: ++activityTurns, lastAction, lastActivityAt: Date.now() });

  const resolvedScope = refMode
    ? pr != null
      ? `pr:${pr}`
      : `branch:${branch}`
    : (scope ?? "uncommitted");
  if (!refMode) validateScope(resolvedScope);

  const startMs = performance.now();
  logger.info(
    { event: "review.start", tool: "review", project: cwd, scope: resolvedScope },
    "review starting",
  );

  // Reused as both the worktree directory name and its branch suffix — same reason
  // dispatch.ts prefers the real job id over a fresh one where it has one available.
  const jobKey = jobId ?? randomUUID();
  let worktree: DispatchWorktree | undefined;
  // Tracked independently of `worktree`, not inferred from it — the fetch ref
  // (`refs/sideclaw-review/<jobKey>`) can exist in the caller's live repo well before
  // `worktree` is ever assigned (`resolveReviewBase`/`createReadWorktree` both run after the
  // fetch and can each throw), so gating cleanup on `worktree` used to leak it permanently on
  // exactly that path. Set the instant the fetch actually lands the ref, by
  // `fetchReviewHead`'s own callback.
  let fetchRefCreated = false;

  try {
    // Every downstream git/session call runs in `effectiveCwd`: the caller's own checkout for
    // the scope-based path, or the throwaway fetched-ref worktree for `pr`/`branch`. Log
    // fields keep reporting the caller's own `cwd` throughout — the worktree path is an
    // implementation detail, not something a consumer should key on.
    let effectiveCwd = cwd;
    let diffCmd: string;
    let filesCmd: string;
    let coderabbitCmd: string;

    if (refMode) {
      bump("fetching ref");
      const headOid = await fetchReviewHead(cwd, jobKey, { pr, branch }, () => {
        fetchRefCreated = true;
      });
      const { baseOid } = await resolveReviewBase(cwd);
      bump("checking out worktree");
      worktree = await createReadWorktree(cwd, jobKey, headOid);
      effectiveCwd = worktree.path;
      diffCmd = refDiffCommand(baseOid);
      filesCmd = refDiffFilesCommand(baseOid);
      coderabbitCmd = `which coderabbit >/dev/null 2>&1 && coderabbit review --prompt-only --base ${baseOid} 2>/dev/null || true`;
    } else {
      diffCmd = gitDiffCommand(resolvedScope);
      filesCmd = gitDiffFilesCommand(resolvedScope);
      coderabbitCmd =
        resolvedScope === "uncommitted"
          ? "which coderabbit >/dev/null 2>&1 && coderabbit review --prompt-only --type uncommitted 2>/dev/null || true"
          : resolvedScope === "head"
            ? "which coderabbit >/dev/null 2>&1 && coderabbit review --prompt-only --type committed 2>/dev/null || true"
            : `which coderabbit >/dev/null 2>&1 && coderabbit review --prompt-only --base ${resolvedScope} 2>/dev/null || true`;
    }

    // ── Phase 1: Data gathering (parallel) ──────────────────────────────
    bump("gathering diff, fallow, coderabbit");

    const [diffResult, filesResult, fallowResult, coderabbitResult, packageJsonResult] =
      await Promise.all([
        shell(diffCmd, effectiveCwd),
        shell(filesCmd, effectiveCwd),
        shell(
          'which fallow >/dev/null 2>&1 && git remote -v 2>/dev/null | grep -q . && fallow audit --quiet 2>&1 || echo ""',
          effectiveCwd,
          60_000,
        ),
        shell(coderabbitCmd, effectiveCwd, 60_000),
        shell("cat package.json 2>/dev/null", effectiveCwd),
      ]);

    // A non-zero exit from `git diff` is a genuine failure (bad scope ref, not a
    // git repo, git missing) — NOT "no changes". Surface it; otherwise the empty
    // stdout below would be misread as a clean review (false positive).
    if (!diffResult.ok) {
      throw new Error(
        `git diff failed for scope "${resolvedScope}": ${diffResult.stdout.trim() || "no output"}`,
      );
    }

    if (!diffResult.stdout.trim()) {
      logger.info(
        {
          event: "review.done",
          tool: "review",
          project: cwd,
          durationMs: Math.round(performance.now() - startMs),
        },
        "review done (no changes)",
      );
      return {
        outcome: "clean",
        blocking: [],
        improvements: [],
        discussions: [],
        testGaps: [],
        summary: "No changes to review.",
        schemaVersion: REVIEW_SCHEMA_VERSION,
      };
    }

    const changedFiles = filesResult.stdout.split("\n").filter(Boolean);
    let hasTestScript = false;
    try {
      const pkg = JSON.parse(packageJsonResult.stdout);
      hasTestScript = !!pkg?.scripts?.test;
    } catch {
      // no package.json or invalid — skip QA agent
    }

    const floorAgents = selectAgents(changedFiles, hasTestScript);

    const contextBlock = context
      ? `\n\n## Author Context\n\n> ${context}\n\nThis is the author's stated intent. Use it to evaluate whether the changes achieve the goal — not to justify shortcuts. If the implementation doesn't match the intent, that's a blocking finding.`
      : "";

    // Optional research-gateway validation for angle workers. Gated on env so review
    // still runs fully when the gateway isn't configured. When set, each angle prompt
    // gets the curl recipe and each angle session gets the bearer creds via extraEnv.
    const gatewayUrl = process.env.RESEARCH_GATEWAY_URL;
    const gatewayToken = process.env.RESEARCH_GATEWAY_TOKEN;
    const researchEnabled = !!(gatewayUrl && gatewayToken);
    const researchBlock = researchEnabled ? RESEARCH_VALIDATION_BLOCK : "";
    const researchEnv: Record<string, string> | undefined = researchEnabled
      ? {
          RESEARCH_GATEWAY_URL: gatewayUrl as string,
          RESEARCH_GATEWAY_TOKEN: gatewayToken as string,
        }
      : undefined;

    // ── Phase 1.5: Dynamic angle routing ─────
    const explicit = angles && angles.length > 0;
    const agents = explicit
      ? resolveRequestedAngles(angles, floorAgents)
      : capAngles(
          [
            ...floorAgents,
            ...(await routeExtraAngles(effectiveCwd, diffCmd, bump, jobId, isCancelled)),
          ],
          MAX_ANGLES,
        );

    logger.info(
      {
        tool: "review",
        project: cwd,
        agents: agents.map((a) => a.angle),
        changedFiles: changedFiles.length,
        routed: !explicit,
        hasFallow: !!fallowResult.stdout,
        hasCoderabbit: !!coderabbitResult.stdout,
        research: researchEnabled,
      },
      "review agents selected",
    );

    // ── Phase 2: Angle reviews (parallel sessions) + adversary critic ────────
    // The adversary runs in parallel with the worker angle fan-out via a single
    // direct fetch to the IU OpenAI transport — different model family, no
    // session-runner, no claude -p, no contention with ANGLE_CONCURRENCY.
    const adversaryPath = join(SKILL_DIR, "adversary.md");
    const adversaryEnabled = process.env.SIDECLAW_REVIEW_ADVERSARY !== "false";
    const adversaryPromise: Promise<AngleResult | null> = adversaryEnabled
      ? runAdversaryAngle({
          diff: diffResult.stdout,
          contextBlock,
          promptPath: adversaryPath,
          bump,
        })
      : Promise.resolve(null);

    const [angleSessionResults, adversaryResult] = await Promise.all([
      mapWithConcurrency(agents, ANGLE_CONCURRENCY, async (agent): Promise<AngleResult> => {
        let prompt: string;
        try {
          prompt = await loadAnglePrompt(agent.angle);
        } catch (err) {
          logger.error(
            { tool: "review", angle: agent.angle, error: String(err) },
            "prompt load failed",
          );
          return {
            angle: agent.angle,
            findings: [],
            failureReason: `prompt load failed: ${String(err)}`,
          };
        }

        prompt = prompt.replace("[GIT_DIFF_COMMAND]", `Run: \`${diffCmd}\``);
        prompt += contextBlock;
        prompt += researchBlock;

        const result = await runSession<AngleOutput>({
          cwd: effectiveCwd,
          prompt,
          tool: "review:angle",
          jobId,
          isCancelled,
          route: routeFor("review"),
          model,
          jsonSchema: ANGLE_JSON_SCHEMA,
          readOnly: true,
          settingSources: "user,project",
          extraEnv: researchEnv,
          validate: zodValidator(ANGLE_OUTPUT),
          onActivity: (p) => bump(`${agent.angle}: ${p.lastAction}`),
        });

        if (!result.ok) {
          logger.error(
            { tool: "review", angle: agent.angle, error: result.error },
            "angle session failed",
          );
          return {
            angle: agent.angle,
            findings: [],
            failureReason: result.error ?? "unknown error",
          };
        }

        logger.info(
          { tool: "review", angle: agent.angle, findings: result.data?.findings.length ?? 0 },
          "angle session done",
        );
        return { angle: agent.angle, findings: result.data?.findings ?? [] };
      }),
      adversaryPromise,
    ]);

    const angleResults: AngleResult[] = adversaryResult
      ? [...angleSessionResults, adversaryResult]
      : angleSessionResults;
    const totalReviewers = agents.length + (adversaryResult ? 1 : 0);

    const failedAngles = angleResults.filter((r) => r.failureReason);

    // ── Short-circuit: if EVERY angle failed, don't pretend a synthesis is meaningful ─
    if (failedAngles.length === totalReviewers) {
      logger.error(
        {
          event: "review.done",
          tool: "review",
          project: cwd,
          outcome: "needs-human",
          failedAngles: failedAngles.length,
          totalAngles: totalReviewers,
          durationMs: Math.round(performance.now() - startMs),
        },
        "review aborted — all angle sessions failed",
      );
      return {
        outcome: "needs-human",
        blocking: [],
        improvements: [],
        discussions: failedAngles.map((r) => ({
          file: "(review pipeline)",
          message: `${r.angle} session failed: ${r.failureReason}`,
          angle: r.angle,
        })),
        testGaps: [],
        summary: `All ${totalReviewers} specialist reviewers failed — no review was actually performed. Causes: ${failedAngles.map((r) => `${r.angle}: ${r.failureReason}`).join("; ")}. Do NOT treat this as approval.`,
        schemaVersion: REVIEW_SCHEMA_VERSION,
      };
    }

    // ── Phase 3: Synthesis ───────────────────────────
    bump("synthesizing findings");
    const synthesisPrompt = await loadAnglePrompt("synthesis");

    const angleBlock = angleResults
      .map((r) => {
        if (r.failureReason) {
          return `**${r.angle}**: ⚠️ SESSION FAILED — ${r.failureReason}. This reviewer did NOT examine the diff. Treat as missing input, not as approval.`;
        }
        if (r.findings.length === 0)
          return `**${r.angle}**: No findings (reviewer ran successfully and approved).`;
        return `**${r.angle}**:\n${JSON.stringify(r.findings, null, 2)}`;
      })
      .join("\n\n");

    const fallowBlock = fallowResult.stdout
      ? `fallow audit output:\n\`\`\`\n${fallowResult.stdout}\n\`\`\``
      : "fallow: not available or skipped.";

    const coderabbitBlock = coderabbitResult.stdout
      ? `CodeRabbit findings:\n\`\`\`\n${coderabbitResult.stdout}\n\`\`\``
      : "CodeRabbit: not available or skipped.";

    const finalPrompt = synthesisPrompt
      .replace("[ANGLE_RESULTS]", angleBlock)
      .replace("[FALLOW_RESULTS]", fallowBlock)
      .replace("[CODERABBIT_RESULTS]", coderabbitBlock);

    const runSynthesis = (synthPrompt: string) =>
      runSession<SynthesisOutput>({
        cwd: effectiveCwd,
        prompt: synthPrompt,
        tool: "review:synthesis",
        jobId,
        isCancelled,
        route: routeFor("review"),
        model,
        jsonSchema: REVIEW_JSON_SCHEMA,
        readOnly: true,
        settingSources: "user,project",
        validate: zodValidator(SYNTHESIS_OUTPUT),
        onActivity: (p) => bump(`synthesis: ${p.lastAction}`),
      });

    let synthesisResult = await runSynthesis(finalPrompt);

    // Salvage: the synthesizer occasionally emits prose instead of the schema JSON.
    // Rather than discard the whole multi-angle run, retry once with a hardened
    // JSON-only directive, then fall back to a needs-human verdict that preserves the
    // raw synthesizer text — a 12-minute run must never end as a bare parse error.
    if (!synthesisResult.ok || !synthesisResult.data) {
      logger.warn(
        { tool: "review", project: cwd, error: synthesisResult.error },
        "synthesis output invalid — retrying with JSON-only directive",
      );
      bump("synthesis: retry (json-only)");
      synthesisResult = await runSynthesis(finalPrompt + SYNTHESIS_JSON_ONLY_RETRY);
    }

    if (!synthesisResult.ok || !synthesisResult.data) {
      const raw = (synthesisResult.rawText ?? synthesisResult.error ?? "").trim();
      logger.error(
        {
          event: "review.done",
          tool: "review",
          project: cwd,
          outcome: "needs-human",
          salvaged: true,
          durationMs: Math.round(performance.now() - startMs),
          error: synthesisResult.error,
        },
        "synthesis failed twice — returning salvaged needs-human verdict",
      );
      return {
        outcome: "needs-human",
        blocking: [],
        improvements: [],
        discussions: [
          {
            file: "(review pipeline)",
            message:
              "Synthesis did not return valid JSON after a retry, so the findings could not be " +
              "structured. The multi-angle review DID run — its raw synthesizer output is preserved " +
              "below for manual triage; re-run the review or read this directly:\n\n" +
              (raw.slice(0, 6000) || "(no synthesizer text was captured)"),
            angle: "synthesis",
          },
        ],
        testGaps: [],
        summary: `Review ran ${totalReviewers} reviewers but synthesis failed to serialize a structured verdict (after one retry). Findings were NOT lost — see the discussions entry for the raw synthesizer text. Treat as needs-human.`,
        schemaVersion: REVIEW_SCHEMA_VERSION,
      };
    }

    const data = synthesisResult.data;

    // Safety net: synthesis must not return "clean" when one or more angles failed.
    if (failedAngles.length > 0 && data.outcome === "clean") {
      data.outcome = "needs-human";
      for (const f of failedAngles) {
        data.discussions.push({
          file: "(review pipeline)",
          message: `${f.angle} session failed: ${f.failureReason} — this angle did not actually review the diff.`,
          angle: f.angle,
        });
      }
      data.summary = `Partial review: ${failedAngles.length}/${totalReviewers} reviewers failed (${failedAngles.map((r) => r.angle).join(", ")}). ${data.summary}`;
    }

    logger.info(
      {
        event: "review.done",
        tool: "review",
        project: cwd,
        outcome: data.outcome,
        blocking: data.blocking.length,
        improvements: data.improvements.length,
        discussions: data.discussions.length,
        testGaps: data.testGaps.length,
        failedAngles: failedAngles.length,
        totalAngles: totalReviewers,
        durationMs: Math.round(performance.now() - startMs),
      },
      "review done",
    );

    return { ...data, schemaVersion: REVIEW_SCHEMA_VERSION };
  } finally {
    // Torn down on every exit path, including a throw — same "the caller's own checkout is
    // never left holding this review's work" property dispatch's read tiers rely on
    // (dispatch-git.ts). The worktree and the fetch ref are two independent pieces of state
    // in the caller's live repo, gated on two independent flags: `worktree` may not exist yet
    // even when the fetch ref does (a throw from `resolveReviewBase`/`createReadWorktree`
    // lands exactly there), so cleanup must not be gated on `worktree` alone.
    if (worktree) {
      await removeWorktree(cwd, worktree);
    }
    if (fetchRefCreated) {
      await cleanupReviewFetchRef(cwd, jobKey);
    }
  }
}
