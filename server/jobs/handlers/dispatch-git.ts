import { existsSync, mkdirSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Octokit } from "@octokit/rest";
import { appLogger as logger } from "../../logger.ts";

// Everything in this file runs in the SIDECLAW PROCESS, never inside a worker session.
//
// That split is the security argument for the write tiers. The worker's prompt is assembled
// from untrusted material (a Slack message, a GitHub issue body), so anything it can reach,
// an injected brief can reach. So the tool hands it nothing: the GitHub token is resolved
// here, the commit is made here, the push refspec is built here, the pull request is opened
// here. The worker's only job is to leave a working tree in a state worth committing.
//
// The corollary — and the precise claim, which is narrower than it first reads — is that
// "never merges, never pushes to a default branch" is a property of THIS FILE rather than a
// line in a prompt. `pushBranch` refuses both by construction, so no shape of worker output
// can talk the handler into either.
//
// It is NOT a claim that the session is incapable of reaching GitHub by itself. It has an
// unrestricted `Bash` and this host has an ambient git credential helper plus a
// promptless `secrets-run`; see GIT_DENY_CREDENTIALS_ENV below for what is and is not
// contained, and docs/dispatch-bridge.md for the residual risk in full.

// ── Bounds ────────────────────────────────────────────────────────────────────

/** Refuse to push a diff that touches the CI execution surface. A dispatched episode has
 *  no business editing what runs on push/PR, and a workflow change arriving inside a PR is
 *  the classic path from "an agent wrote a file" to "an agent ran code in CI". Refusing at
 *  the push step (rather than instructing the worker not to) is what makes it a bound. */
const FORBIDDEN_PATH_RE = /^\.github\/(workflows|actions)\//;

/** Review-burden ceilings. An unattended episode that rewrites half a repo produces a PR
 *  nobody will read, which is indistinguishable from no PR at all — except that it also
 *  cost Max quota. These are deliberately low: a dispatch is a bounded change. */
const MAX_CHANGED_FILES = 40;
const MAX_CHANGED_LINES = 2000;

const SECRETS_RUN = join(homedir(), ".local", "bin", "secrets-run");
const GITHUB_TOKEN_REF = "op://mini/github/token";

/** Worktrees live outside every repo, under sideclaw's own state dir. Inside the repo they
 *  would show up in the live checkout's `git status` as an untracked directory, which is
 *  precisely the "the live checkout is untouched" property the isolation exists to provide. */
const WORKTREE_ROOT = join(homedir(), ".local", "state", "sideclaw", "worktrees");

/**
 * Env overlay that removes git's ambient push credential from a worker session.
 *
 * The problem it addresses is real and non-obvious. On this mini `~/.gitconfig` ends with
 * an `[include]` of `~/.gitconfig-headless`, which points the GitHub credential helper at
 * the age-encrypted secrets cache — deliberately, so unattended pushes need neither the
 * keychain nor the biometric 1Password agent. The side effect is that ANY process running
 * as this user can push to GitHub with no secret of its own, and a worker session has
 * `Bash`. Scrubbing `SENSITIVE_ENV_RE` from the worker env (session-runner) does nothing
 * about it: the credential never travels through the environment.
 *
 * So the config is taken away. `GIT_CONFIG_GLOBAL=/dev/null` drops the include and with it
 * the helper; `GIT_TERMINAL_PROMPT=0` plus a false askpass turns the resulting auth failure
 * into an immediate error instead of a hang; `GIT_SSH_COMMAND=false` closes the ssh remote
 * path, which `~/.gitconfig-headless`'s `insteadOf` rewrite would otherwise no longer be
 * there to redirect. The repo-local `.git/config` still resolves, so reading history — the
 * thing every tier actually needs — is unaffected.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────────────────
 * It is NOT a privilege boundary, and nothing here should be read as one. It is an env
 * overlay, and the session it constrains has an unrestricted `Bash` under
 * `--dangerously-skip-permissions`. A session that wants to get around it can:
 *
 *   - restore the config it was denied — `GIT_CONFIG_GLOBAL=$HOME/.gitconfig git push …`;
 *   - resolve the token itself — `secrets-run read op://mini/github/token` needs no prompt
 *     on this host, and the user-level CLAUDE.md this tier deliberately loads spells that
 *     recipe out.
 *
 * Both were found by adversarial review, both were confirmed, and neither is fixable with
 * another environment variable — the honest fix is an OS-level sandbox (restricted PATH is
 * theatre: an absolute path defeats it). What this overlay genuinely buys is that the
 * *default, effortless* path to a mutation is gone: an eager-but-not-hostile worker that
 * decides to be helpful and `git push` its work simply fails in under a second. Treat it as
 * raising the cost of an accident, not as containing an adversary.
 *
 * The guarantees that ARE structural live below, in `pushBranch` and `openPullRequest`, and
 * they constrain THE HANDLER — never the session. See docs/dispatch-bridge.md.
 *
 * Identity is supplied explicitly because nulling the global config also removes
 * `user.name`/`user.email`: a worker that decides to commit should succeed and produce a
 * normal commit rather than fail with "Please tell me who you are". The commit is the
 * owner's, made on their behalf — there is no bot author here.
 */
export const GIT_DENY_CREDENTIALS_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/usr/bin/false",
  SSH_ASKPASS: "/usr/bin/false",
  GIT_SSH_COMMAND: "false",
  GIT_AUTHOR_NAME: "jkrumm",
  GIT_AUTHOR_EMAIL: "jkrumm@pm.me",
  GIT_COMMITTER_NAME: "jkrumm",
  GIT_COMMITTER_EMAIL: "jkrumm@pm.me",
};

// ── Subprocess helper ─────────────────────────────────────────────────────────

interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  cmd: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, opts.timeoutMs ?? 60_000);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return {
      ok: !timedOut && code === 0,
      code,
      stdout,
      stderr: timedOut ? `${stderr}\n(timed out after ${opts.timeoutMs ?? 60_000}ms)` : stderr,
    };
  } finally {
    clearTimeout(timer);
  }
}

function git(args: string[], cwd: string, timeoutMs = 60_000): Promise<RunResult> {
  return run(["git", ...args], { cwd, timeoutMs });
}

async function gitOrThrow(args: string[], cwd: string, timeoutMs = 60_000): Promise<string> {
  const r = await git(args, cwd, timeoutMs);
  if (!r.ok) {
    throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim().slice(0, 400)}`);
  }
  return r.stdout.trim();
}

// ── GitHub ────────────────────────────────────────────────────────────────────

let cachedToken: string | undefined;

/**
 * Resolve the GitHub token.
 *
 * `op://mini/github/token` first, deliberately: it is the fleet's GitHub credential and
 * already the one the git credential helper uses for the push half of an implement episode,
 * so preferring it means one credential covers the whole operation instead of the branch and
 * the pull request arriving under different identities.
 *
 * `GITHUB_TOKEN` from sideclaw's `.env` is a documented fallback, not the primary. It is a
 * `gho_` OAuth token, which is the same class this fleet retired from the git credential
 * path on 2026-07-26 for expiring silently — a token that stops working without saying so is
 * a bad thing to depend on for an unattended episode, and the ordering here is what keeps it
 * from quietly becoming the real dependency again.
 *
 * `secrets-run` is the op shim: on this headless mini it decrypts the offline cache, so
 * there is no biometric prompt to hang on. A bare `op` here would block forever, which is
 * why the ref is never read directly.
 */
async function githubToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  if (existsSync(SECRETS_RUN)) {
    const r = await run([SECRETS_RUN, "read", GITHUB_TOKEN_REF], { timeoutMs: 20_000 });
    const token = r.stdout.trim();
    if (r.ok && token) {
      cachedToken = token;
      return token;
    }
    logger.warn(
      { event: "dispatch.token_fallback", error: r.stderr.trim().slice(0, 200) },
      `could not resolve ${GITHUB_TOKEN_REF} — falling back to GITHUB_TOKEN`,
    );
  }
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) {
    cachedToken = fromEnv;
    return fromEnv;
  }
  throw new Error(
    `no GitHub credential: ${GITHUB_TOKEN_REF} did not resolve via ${SECRETS_RUN} and GITHUB_TOKEN is unset`,
  );
}

async function octokit(): Promise<Octokit> {
  return new Octokit({
    auth: await githubToken(),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
}

/**
 * Turn a 403 from an artifact call into an actionable one.
 *
 * The fine-grained PAT behind `op://mini/github/token` needs `Contents: write` for the push
 * — which it has, since the push is what the git credential helper does with it — plus
 * `Issues: write` and `Pull requests: write` for the artifact. Those are separate grants, and
 * a token holding only the first pushes the branch successfully and then fails at the last
 * step. GitHub's own message for that is "Resource not accessible by personal access token",
 * which names neither the permission nor the token, so it gets named here.
 */
function describeGithubFailure(err: unknown, what: string): Error {
  const status = (err as { status?: number })?.status;
  if (status === 403 || status === 404) {
    return new Error(
      `GitHub refused to ${what} (HTTP ${status}). The credential is missing a permission: a ` +
        `fine-grained PAT needs "Issues: write" and "Pull requests: write" in addition to ` +
        `"Contents: write". Grant them to the token behind ${GITHUB_TOKEN_REF}, then re-seed ` +
        `the offline cache (\`make secrets-seed\` in dotfiles, biometric, MacBook-only).`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

export interface RepoIdentity {
  owner: string;
  repo: string;
  defaultBranch: string;
}

/** Parse `owner/repo` out of a GitHub remote URL, in either the https or ssh spelling. */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const m =
    url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/) ??
    url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/) ??
    url.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m?.[1] || !m[2]) return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * Identify the GitHub repo behind a checkout, and its default branch.
 *
 * The default branch comes from the GitHub API rather than from `origin/HEAD`, because the
 * local symbolic ref is a cached guess: it is written at clone time and never updated, so a
 * repo whose default branch was renamed reports the old one indefinitely. Everything the
 * write tiers refuse to do is defined relative to this value ("never push to a default
 * branch"), so it has to be the authoritative one, and the API call is needed anyway to
 * open the artifact.
 */
export async function resolveRepoIdentity(cwd: string): Promise<RepoIdentity> {
  const url = await gitOrThrow(["remote", "get-url", "origin"], cwd);
  const parsed = parseGithubRemote(url);
  if (!parsed) {
    throw new Error(
      `origin is not a GitHub remote (${url}) — the author and implement tiers need one to deposit their artifact`,
    );
  }
  const gh = await octokit();
  const { data } = await gh.repos.get({ owner: parsed.owner, repo: parsed.repo });
  return { ...parsed, defaultBranch: data.default_branch };
}

export async function openIssue(
  id: RepoIdentity,
  opts: { title: string; body: string },
): Promise<string> {
  const gh = await octokit();
  const { data } = await gh.issues
    .create({
      owner: id.owner,
      repo: id.repo,
      title: opts.title,
      body: opts.body,
    })
    .catch((err: unknown) => {
      throw describeGithubFailure(err, `file an issue in ${id.owner}/${id.repo}`);
    });
  logger.info(
    { event: "dispatch.issue", repo: `${id.owner}/${id.repo}`, number: data.number },
    "dispatch opened issue",
  );
  return data.html_url;
}

/**
 * Open a pull request. Draft by default: a branch produced by an unattended episode is a
 * proposal, and "ready for review" is one click away for a human who has looked at it —
 * whereas un-drafting is not something the episode can do for itself.
 */
export async function openPullRequest(
  id: RepoIdentity,
  opts: { title: string; body: string; head: string },
): Promise<string> {
  if (opts.head === id.defaultBranch) {
    throw new Error(`refusing to open a PR whose head is the default branch (${opts.head})`);
  }
  const gh = await octokit();
  const { data } = await gh.pulls
    .create({
      owner: id.owner,
      repo: id.repo,
      title: opts.title,
      body: opts.body,
      head: opts.head,
      base: id.defaultBranch,
      draft: true,
    })
    .catch((err: unknown) => {
      throw describeGithubFailure(err, `open a pull request in ${id.owner}/${id.repo}`);
    });
  logger.info(
    { event: "dispatch.pr", repo: `${id.owner}/${id.repo}`, number: data.number },
    "dispatch opened pull request",
  );
  return data.html_url;
}

// ── Worktree lifecycle ────────────────────────────────────────────────────────

export interface DispatchWorktree {
  /** Absolute path of the isolated checkout the session runs in. */
  path: string;
  /** Branch created for this episode. Always `dispatch/…`. */
  branch: string;
  /** Ref the branch was cut from, e.g. `origin/master`. */
  base: string;
}

/** Branch-safe slug from free text. Output is `[a-z0-9-]+`, so it cannot express any of
 *  git's ref-name hazards (`..`, `~`, `^`, `:`, a trailing `.lock`, a leading `-`). */
export function slugify(text: string, max = 40): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return s || "work";
}

/**
 * Create an isolated worktree on a fresh `dispatch/…` branch.
 *
 * `git worktree add` writes a new checkout at a path outside every repo and a ref inside
 * `.git`; it does not touch the live checkout's working tree, index or HEAD. That is the
 * property the implement tier depends on — other agents on this mini are using those
 * checkouts, and an episode that fails halfway must leave them exactly as it found them.
 */
export async function createWorktree(
  cwd: string,
  jobKey: string,
  slug: string,
  defaultBranch: string,
): Promise<DispatchWorktree> {
  const branch = `dispatch/${slug}-${jobKey.slice(0, 8)}`;
  const path = join(WORKTREE_ROOT, jobKey);
  mkdirSync(WORKTREE_ROOT, { recursive: true });
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });

  // Best effort: a stale `origin/<default>` only means the branch is cut from an older
  // base, which a PR shows as needing a rebase. A hard failure here (offline, throttled)
  // must not cost the episode.
  const fetched = await git(["fetch", "origin", defaultBranch], cwd, 120_000);
  let base = `origin/${defaultBranch}`;
  if (!fetched.ok) {
    logger.warn(
      { event: "dispatch.fetch_failed", project: cwd, error: fetched.stderr.trim().slice(0, 200) },
      "could not fetch origin — cutting the branch from the local ref instead",
    );
  }
  if (!(await git(["rev-parse", "--verify", "--quiet", base], cwd)).ok) {
    base = defaultBranch;
    if (!(await git(["rev-parse", "--verify", "--quiet", base], cwd)).ok) {
      throw new Error(
        `cannot resolve a base ref: neither origin/${defaultBranch} nor ${defaultBranch} exists`,
      );
    }
  }

  await gitOrThrow(["worktree", "add", "--quiet", "-b", branch, path, base], cwd, 120_000);
  logger.info({ event: "dispatch.worktree", project: cwd, branch, base, path }, "worktree created");
  return { path, branch, base };
}

/** Tear the worktree down. Always safe to call, including after a failure and including
 *  when the worktree was never created — cleanup must never be the thing that turns a
 *  failed episode into a broken repo. The pushed remote branch is untouched. */
export async function removeWorktree(cwd: string, wt: DispatchWorktree): Promise<void> {
  await git(["worktree", "remove", "--force", wt.path], cwd);
  if (existsSync(wt.path)) rmSync(wt.path, { recursive: true, force: true });
  await git(["worktree", "prune"], cwd);
  // Deleting the local branch is safe after a push: the remote holds the ref the PR points
  // at. Before a push it is the right cleanup too — nothing references it.
  await git(["branch", "-D", wt.branch], cwd);
}

// ── Diff inspection and commit ────────────────────────────────────────────────

export interface DiffSummary {
  files: string[];
  insertions: number;
  deletions: number;
}

/**
 * Files and line counts between the base and the branch tip.
 *
 * `--no-renames` is load-bearing, not tidiness. Rename detection is ON by default, and it
 * collapses a rename into a SINGLE numstat row whose path field reads
 * `src/thing.ts => .github/workflows/evil.yml`. `FORBIDDEN_PATH_RE` is anchored at the start
 * of the string, so it does not match that form — meaning `git mv anything .github/workflows/x.yml`
 * walked straight through the CI-path bound. Measured, not theorised. Turning rename
 * detection off yields the two real paths (and honest per-file line counts, which also makes
 * the size ceilings accurate rather than reporting a rename as 0 changed lines).
 */
export async function summarizeDiff(wt: DispatchWorktree): Promise<DiffSummary> {
  const out = await gitOrThrow(["diff", "--no-renames", "--numstat", `${wt.base}...HEAD`], wt.path);
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [add, del, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    files.push(path);
    // "-" in place of a count means a binary file; it contributes files but no lines.
    insertions += Number.parseInt(add ?? "0", 10) || 0;
    deletions += Number.parseInt(del ?? "0", 10) || 0;
  }
  return { files, insertions, deletions };
}

/** Commit whatever the session left uncommitted. Returns true if a commit was made.
 *  The session is told not to commit, but "told not to" is not a guarantee and a session
 *  that commits anyway is not an error — both shapes have to land the same artifact. */
export async function commitPendingWork(wt: DispatchWorktree, message: string): Promise<boolean> {
  await gitOrThrow(["add", "-A"], wt.path);
  const staged = await git(["diff", "--cached", "--quiet"], wt.path);
  if (staged.code === 0) return false; // nothing staged
  await gitOrThrow(["commit", "--no-verify", "-m", message], wt.path);
  return true;
}

/** Commits the branch carries beyond its base. Zero means the episode changed nothing. */
export async function commitCount(wt: DispatchWorktree): Promise<number> {
  const out = await gitOrThrow(["rev-list", "--count", `${wt.base}..HEAD`], wt.path);
  return Number.parseInt(out, 10) || 0;
}

/** Why this diff may not be pushed, or null if it may. Separated from the push so the
 *  handler can report the reason in the verdict instead of failing the whole episode. */
export function diffRefusalReason(diff: DiffSummary): string | null {
  const forbidden = diff.files.filter((f) => FORBIDDEN_PATH_RE.test(f));
  if (forbidden.length > 0) {
    return `the change touches the CI execution surface (${forbidden.join(", ")}), which a dispatched episode may never modify`;
  }
  if (diff.files.length > MAX_CHANGED_FILES) {
    return `the change touches ${diff.files.length} files, over the ${MAX_CHANGED_FILES}-file ceiling for an unattended episode`;
  }
  const lines = diff.insertions + diff.deletions;
  if (lines > MAX_CHANGED_LINES) {
    return `the change is ${lines} lines, over the ${MAX_CHANGED_LINES}-line ceiling for an unattended episode`;
  }
  return null;
}

/**
 * Push the episode's branch, and only it.
 *
 * Three refusals, all structural. The refspec is built here and names exactly one branch,
 * so there is no shape of worker output that turns this into a push to another ref; the
 * default-branch check is explicit rather than implied by the refspec, because that is the
 * invariant a reader needs to see stated; and the `dispatch/` prefix means a push can only
 * ever land in the namespace this tool owns. There is no force flag anywhere — the branch
 * is new, so a push that would need one is a bug worth failing on.
 */
export async function pushBranch(wt: DispatchWorktree, id: RepoIdentity): Promise<void> {
  if (wt.branch === id.defaultBranch) {
    throw new Error(`refusing to push to the default branch (${id.defaultBranch})`);
  }
  if (!wt.branch.startsWith("dispatch/")) {
    throw new Error(`refusing to push a branch outside the dispatch/ namespace (${wt.branch})`);
  }
  const head = await gitOrThrow(["rev-parse", "--abbrev-ref", "HEAD"], wt.path);
  if (head !== wt.branch) {
    throw new Error(
      `worktree HEAD is ${head}, not the episode's branch ${wt.branch} — refusing to push a branch this episode did not create`,
    );
  }
  await gitOrThrow(
    ["push", "origin", `refs/heads/${wt.branch}:refs/heads/${wt.branch}`],
    wt.path,
    180_000,
  );
}
