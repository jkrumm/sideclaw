import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  lstatSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
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
// promptless `secrets-run`; see GIT_DENY_CREDENTIALS_ENV below — its own doc comment spells
// out the residual risk in full ("WHAT THIS IS NOT").

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

/**
 * Patterns that must never reach a GitHub issue or pull request body.
 *
 * This is new blast radius that no earlier sideclaw tool had: `check` and `review` return
 * text to one caller, whereas an artifact is durable, indexed and — for most repos in the
 * allowlist — world-readable. The text being published is authored by a session whose
 * context holds an untrusted brief AND whatever it read inside the repo, and the provenance
 * footer quotes the brief verbatim. The brief is assembled from Slack messages and log
 * lines, which are private; the issue is not. That asymmetry is the leak.
 *
 * A prompt instruction telling the worker not to quote secrets is not a control, so this
 * runs in the handler, after the worker is done and before anything is published.
 */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "1Password reference", re: /\bop:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/ },
  { name: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private key block", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { name: "bearer credential", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  // Tailscale CGNAT range (100.64.0.0/10) — an internal hostname or tailnet address in a
  // public issue is exactly what the global security rule forbids in tracked files. The
  // second octet is 64-127 inclusive and the alternation says exactly that: an earlier
  // `1[0-2]\d` also admitted 100.128/129, which are ordinary public addresses, and a
  // refusal is only useful if it does not fire on things nobody needs to hide.
  {
    name: "Tailscale IP",
    re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/,
  },
  {
    name: "inline credential assignment",
    re: /\b(?:api[_-]?key|secret|password|passwd|auth[_-]?token|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_\-+/]{20,}/i,
  },
];

/** Names of every secret pattern the text matches. Empty means it looks publishable. */
export function scanForSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

/**
 * Refuse to publish text that looks like it carries a credential.
 *
 * Refuses rather than redacts, deliberately. A redaction that silently mangles a legitimate
 * issue body is a worse failure than not filing it: the episode's verdict still reaches the
 * caller with the reason attached, so nothing is lost except the artifact, and re-running
 * with a narrower brief is cheap. Publishing a redacted-but-wrong body to a public repo is
 * not reversible in the same way — it is in the timeline, the API and every mirror the
 * moment it exists.
 */
function assertNoSecrets(text: string, what: string): void {
  const hits = scanForSecrets(text);
  if (hits.length > 0) {
    throw new Error(
      `refusing to publish ${what}: the text matches ${hits.join(", ")}. A dispatched ` +
        `episode must never put a credential or an internal address into a durable, ` +
        `possibly public artifact. Nothing was published.`,
    );
  }
}

/** Base of every sideclaw state directory that must outlive a process restart and must never
 *  live in `/tmp` (macOS sweeps untouched `/tmp` files after 3+ days — the same reasoning as
 *  the logs). Worktrees, salvage bundles and verdicts withheld by the sensitive-dispatch
 *  secret scan (`writeWithheldVerdict`, below) all live under this one root. */
function sideclawStateRoot(): string {
  return join(homedir(), ".local", "state", "sideclaw");
}

/**
 * Worktrees live outside every repo, under sideclaw's own state dir. Inside the repo they
 * would show up in the live checkout's `git status` as an untracked directory, which is
 * precisely the "the live checkout is untouched" property the isolation exists to provide.
 *
 * Read per call rather than frozen at import, so the test suite can point it at a temp dir.
 * That seam is not optional cosmetics: `sweepStaleWorktrees` deletes EVERY directory under
 * this root on the stated assumption that only one instance of this server exists, and a
 * test run is a second process — against the real root it would tear down a live episode's
 * worktree. The env var is never set in production.
 */
function worktreeRoot(): string {
  return process.env.SIDECLAW_WORKTREE_ROOT ?? join(sideclawStateRoot(), "worktrees");
}

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
 * they constrain THE HANDLER — never the session.
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
  assertNoSecrets(`${opts.title}\n${opts.body}`, "a GitHub issue");
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
  assertNoSecrets(`${opts.title}\n${opts.body}`, "a pull request");
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
  /**
   * Immutable OID the branch was cut from, and the fixed point every bound is measured
   * against. It is a resolved SHA, never a ref NAME, and that is load-bearing: a worktree
   * shares `.git` with the live repo, so a writable session can `git update-ref
   * refs/remotes/origin/master <its own commit>` and move a name-based base underneath the
   * inspection. Then `base...HEAD` shows an innocent diff, `diffRefusalReason` approves it,
   * and the forbidden change is pushed anyway. A SHA cannot be repointed.
   */
  base: string;
  /** Human-readable ref the OID was resolved from, for logs only. Never used to compare. */
  baseRef: string;
  /**
   * May the handler push this branch? True only for the implement tier's worktree.
   *
   * A property of the object rather than a re-derivation of the tier at each call site,
   * because the read tiers now get a worktree too and the difference between the two kinds
   * is exactly this. Without it, `salvage` — which pushes whatever the session left behind
   * when it failed to serialize — would happily publish a read-only episode's leftovers.
   */
  pushable: boolean;
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
  const root = worktreeRoot();
  const path = join(root, jobKey);
  mkdirSync(root, { recursive: true });
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

  // Pin the base to an OID before anything else can move it. See DispatchWorktree.base.
  const baseOid = await gitOrThrow(["rev-parse", "--verify", `${base}^{commit}`], cwd);

  try {
    await gitOrThrow(["worktree", "add", "--quiet", "-b", branch, path, baseOid], cwd, 120_000);
  } catch (err) {
    // `git worktree add` can fail after it has already registered `.git/worktrees/<name>`
    // or created part of the directory — a timeout SIGKILLs it mid-checkout. The caller
    // never receives a DispatchWorktree in that case, so its `finally` has nothing to clean
    // up and the partial state would be left in the live repo this whole mechanism exists
    // to leave untouched. Clean up here, where the state is still known.
    await discardWorktree(cwd, path, branch);
    throw err;
  }
  logger.info(
    { event: "dispatch.worktree", project: cwd, branch, base: baseOid, baseRef: base, path },
    "worktree created",
  );
  return { path, branch, base: baseOid, baseRef: base, pushable: true };
}

/**
 * Create a throwaway worktree at the checkout's current HEAD, for a tier that only reads.
 *
 * `readOnly: true` takes Edit and Write off the session. It does not take away Bash, and the
 * prompt is assembled from a brief the caller built out of Slack messages and issue bodies —
 * so a read tier running in the live checkout is one injected `sed -i` away from editing a
 * repo that other agents are working in and that deploys to production on push. It gets its
 * own copy instead, torn down when the episode ends: the same teardown, and the same "a
 * failed episode leaves the live checkout untouched" property, that implement already had.
 *
 * Cut from HEAD by default, not from `origin/<default>`: a read tier is answering a question
 * about *this* checkout, so the commit it is sitting on is the right thing to read, and there
 * is no artifact that will later need rebasing. That also means no fetch and no GitHub API
 * call, which is what keeps `investigate` working in a repo whose origin is not GitHub, or
 * missing entirely — the read tiers resolve no identity.
 *
 * `atOid`, when given, checks out that commit instead of HEAD — the seam `review` uses to
 * inspect a fetched PR/branch ref rather than the live checkout's own tip. The caller is
 * responsible for making sure the OID already resolves in `cwd`'s object database (e.g. via a
 * prior `git fetch`); this function does no fetching of its own either way.
 *
 * `git worktree add` only materializes TRACKED content at the pinned commit — that is a side
 * effect of the underlying git command, not a deliberate security guard, so a read episode
 * used to be answering a question about a checkout it could only half see: no `.env`, no
 * local config, no build output, no untracked scratch files. `copyUntrackedFiles` closes that
 * gap afterwards, best effort, with `.claude/` excluded for reasons that ARE security (see its
 * own comment) — reopening nothing, because the exposure this worktree exists to prevent is a
 * write landing in the live checkout, and copying files IN doesn't touch that. Untracked files
 * are only ever copied from `cwd`'s OWN working tree, so this step is skipped for an `atOid`
 * checkout — the untracked scratch files of the live checkout have no relationship to a
 * fetched PR/branch ref, and copying them in would mix the two.
 *
 * The narrow claim, because the wide one would be false: this isolates the WORKING TREE. The
 * worktree shares `.git` with the live repo, and nothing confines the session's Bash to the
 * filesystem below it. What it buys is that the natural spelling of an injected write — a
 * relative path, a tool defaulting to cwd — lands somewhere nobody reads and nothing deploys.
 */
export async function createReadWorktree(
  cwd: string,
  jobKey: string,
  atOid?: string,
): Promise<DispatchWorktree> {
  const branch = `dispatch/read-${jobKey.slice(0, 8)}`;
  const root = worktreeRoot();
  const path = join(root, jobKey);
  mkdirSync(root, { recursive: true });
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });

  const baseOid = atOid ?? (await gitOrThrow(["rev-parse", "--verify", "HEAD^{commit}"], cwd));
  const baseRef = atOid ? atOid.slice(0, 12) : "HEAD";
  try {
    await gitOrThrow(["worktree", "add", "--quiet", "-b", branch, path, baseOid], cwd, 120_000);
  } catch (err) {
    await discardWorktree(cwd, path, branch);
    throw err;
  }
  logger.info(
    { event: "dispatch.worktree", project: cwd, branch, base: baseOid, baseRef, path },
    "read worktree created",
  );
  const wt: DispatchWorktree = { path, branch, base: baseOid, baseRef, pushable: false };
  if (!atOid) await copyUntrackedFiles(cwd, wt);
  return wt;
}

// ── Untracked-file materialization (read tiers only) ──────────────────────────

/** Total-bytes and file-count ceilings on the untracked-content copy. Purely a cost bound —
 *  unlike the diff-review ceilings above, there is no review burden here to protect, just the
 *  time and disk this copy is allowed to spend before it stops being "near-free". */
const MAX_COPY_BYTES = 100 * 1024 * 1024;
const MAX_COPY_FILES = 5_000;

/**
 * Directory segments never copied, regardless of size or count.
 *
 * `.claude` is the one that is security-critical, not cost-driven, and must never be relaxed:
 * `stripProjectSettings` (below) exists because a repo's `.claude/settings.json` can override
 * the handler's environment, including `GIT_DENY_CREDENTIALS_ENV` — a live hole closed
 * 2026-08-03. That strip only removes what `git worktree add` materializes from TRACKED
 * history; an untracked `.claude/settings.local.json` sitting in the live checkout would walk
 * straight past it if this copy brought it in. So any path with a `.claude` segment is
 * excluded here, unconditionally, before the strip ever runs. The rest are ordinary
 * cost-control — the directories most likely to hold thousands of files nobody dispatched an
 * episode to read.
 */
const EXCLUDED_COPY_SEGMENTS = new Set([
  ".claude",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".git",
]);

function isExcludedFromCopy(relPath: string): boolean {
  return relPath.split("/").some((seg) => EXCLUDED_COPY_SEGMENTS.has(seg));
}

/**
 * Copy untracked and gitignored files from the live checkout (`cwd`) into a read tier's
 * throwaway worktree, so the episode can see what `git worktree add` cannot: `.env`, local
 * state/config, build output, scratch files.
 *
 * Enumerated via `git ls-files --others -z` (no `--exclude-standard`) rather than a filesystem
 * walk, so git's own ignore semantics decide what counts as "untracked" and gitignored files
 * are included, not filtered out.
 *
 * `fs.copyFileSync` with `COPYFILE_FICLONE` is Node/Bun's own "try a COW clone, fall back to a
 * plain copy" primitive — no platform branch needed. The worktree root and the checkout are
 * normally on the same volume, so on APFS this is near-free; elsewhere it silently degrades to
 * an ordinary copy.
 *
 * Best effort, end to end, by design: this must degrade to "fewer files present in the
 * worktree", never to a failed episode. Every failure path logs and continues; the function
 * itself never throws. Hitting the cost cap is the one case that is loud rather than silent —
 * `logger.warn` with the count/bytes skipped, because a bound nobody can see approaching reads
 * as the tool being broken.
 */
export async function copyUntrackedFiles(cwd: string, wt: DispatchWorktree): Promise<void> {
  try {
    const listing = await git(["ls-files", "--others", "-z"], cwd, 60_000);
    if (!listing.ok) {
      logger.warn(
        {
          event: "dispatch.untracked_copy_list_failed",
          branch: wt.branch,
          error: listing.stderr.trim().slice(0, 200),
        },
        "could not enumerate untracked files — the read worktree will only carry tracked content",
      );
      return;
    }
    const candidates = listing.stdout
      .split("\0")
      .filter(Boolean)
      .filter((p) => !isExcludedFromCopy(p));

    let copiedFiles = 0;
    let copiedBytes = 0;
    let cappedFiles = 0;
    let cappedBytes = 0;
    let failedFiles = 0;

    for (const rel of candidates) {
      const src = join(cwd, rel);
      let size: number;
      try {
        // lstat, NOT stat: stat FOLLOWS a symlink, so an untracked `link -> ~/.ssh/id_ed25519`
        // would report as a regular file and its TARGET's content would be cloned into the
        // worktree as a real file. The episode's Bash is not confined to the worktree and
        // could read that path directly either way, so this is not a new capability — but a
        // read tier's whole job is to sweep the tree it was given, and materializing a secret
        // INSIDE that tree gets it hoovered into a verdict with nobody intending it. Skip
        // every non-regular entry, symlinks included; the link target is not this copy's
        // business.
        const st = lstatSync(src);
        if (!st.isFile()) continue; // symlinks/sockets/fifos — nothing safe to clone
        size = st.size;
      } catch {
        continue; // gone between the listing and the stat — nothing to copy
      }

      if (copiedFiles >= MAX_COPY_FILES || copiedBytes + size > MAX_COPY_BYTES) {
        cappedFiles++;
        cappedBytes += size;
        continue;
      }

      try {
        const dest = join(wt.path, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest, fsConstants.COPYFILE_FICLONE);
        copiedFiles++;
        copiedBytes += size;
      } catch (err) {
        failedFiles++;
        logger.warn(
          {
            event: "dispatch.untracked_copy_file_failed",
            branch: wt.branch,
            path: rel,
            error: String(err),
          },
          "could not copy an untracked file into the read worktree",
        );
      }
    }

    if (cappedFiles > 0) {
      logger.warn(
        {
          event: "dispatch.untracked_copy_capped",
          branch: wt.branch,
          copiedFiles,
          copiedBytes,
          cappedFiles,
          cappedBytes,
        },
        `untracked-file copy hit its bound (${MAX_COPY_FILES} files / ${MAX_COPY_BYTES} bytes) — ${cappedFiles} file(s) (${cappedBytes} bytes) were not copied into the read worktree`,
      );
    } else if (copiedFiles > 0) {
      logger.info(
        { event: "dispatch.untracked_copy", branch: wt.branch, copiedFiles, copiedBytes },
        "copied untracked and gitignored files into the read worktree",
      );
    }
  } catch (err) {
    logger.warn(
      { event: "dispatch.untracked_copy_failed", branch: wt.branch, error: String(err) },
      "could not copy untracked files into the read worktree — continuing with tracked content only",
    );
  }
}

/** Tear the worktree down. Always safe to call, including after a failure and including
 *  when the worktree was never created — cleanup must never be the thing that turns a
 *  failed episode into a broken repo. The pushed remote branch is untouched. */
export async function removeWorktree(cwd: string, wt: DispatchWorktree): Promise<void> {
  await discardWorktree(cwd, wt.path, wt.branch);
}

/** The teardown itself, by path and branch rather than by DispatchWorktree, so the partial
 *  state a failed `worktree add` leaves behind is cleaned up by the same code that cleans up
 *  a completed episode. Every step is best effort and none of them throws. */
async function discardWorktree(cwd: string, path: string, branch: string): Promise<void> {
  await git(["worktree", "remove", "--force", path], cwd);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  await git(["worktree", "prune"], cwd);
  // Deleting the local branch is safe after a push: the remote holds the ref the PR points
  // at. Before a push it is the right cleanup too — nothing references it.
  if (branch) await git(["branch", "-D", branch], cwd);
}

// ── Salvage ────────────────────────────────────────────────────────────────────
//
// A killed process loses the ordinary way today: the worker session finishes editing files,
// and only AFTER that does the handler commit (`commitPendingWork`) and push (`pushBranch`).
// A SIGKILL mid-episode leaves those edits sitting uncommitted in the worktree, and the next
// boot's `sweepStaleWorktrees` deletes them with `worktree remove --force` — silently, a
// `warn` log line and nothing else. `runDispatch`'s own `catch` hits the same shape
// synchronously: an unexpected throw after the session already wrote files, discarded by the
// `finally` a moment later with no record of what was lost. Both call `salvageWorktree` right
// before the discard they cannot prevent.

/** Salvage bundles live outside every repo, alongside the worktree root but never inside it —
 *  same reasoning as `worktreeRoot()`: read per call so the test suite can point it at a temp
 *  dir without touching the real one. `~/.local/state/sideclaw/salvage/`, never `/tmp` — macOS
 *  sweeps untouched `/tmp` files after 3+ days (`.claude/rules/logs.md`), which is exactly the
 *  wrong lifetime for the one copy of a crashed episode's work. */
function salvageRoot(): string {
  return process.env.SIDECLAW_SALVAGE_ROOT ?? join(sideclawStateRoot(), "salvage");
}

/**
 * Verdicts withheld by the sensitive-dispatch secret scan (see `dispatch.ts`'s
 * `applySensitiveScan`) — same base as worktrees/salvage, its own env override for the test
 * suite, never `/tmp` for the same reason as both.
 */
export function privateVerdictsRoot(): string {
  return (
    process.env.SIDECLAW_PRIVATE_VERDICTS_ROOT ?? join(sideclawStateRoot(), "private-verdicts")
  );
}

/**
 * Persist the FULL, unmodified verdict for a `sensitive` dispatch episode whose output
 * matched the secret scanner, before the sanitized stand-in replaces it in what the caller
 * receives.
 *
 * This is the one place sideclaw deliberately writes text that may carry a live credential to
 * disk, so filesystem permissions are the actual boundary here, not a convention: the
 * directory is created `0700` and the file `0600` — owner-only, every time, since `mkdirSync`
 * only applies `mode` to directories it creates and this call always creates a fresh,
 * uniquely-named file (one per job id).
 *
 * Refusing here — the scanner's usual stance for an issue/PR body — was considered and
 * rejected: this is the only artifact of a read-only investigation the caller asked for, and
 * throwing it away recovers nothing. An issue/PR refusal loses nothing recoverable (re-running
 * with a narrower brief is cheap); a withheld investigate verdict has no narrower re-run that
 * doesn't just repeat the same finding. So the full text is kept, just not put on the wire.
 */
export function writeWithheldVerdict(jobId: string, markdown: string): string {
  const root = privateVerdictsRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${jobId}.md`);
  writeFileSync(path, markdown, { mode: 0o600 });
  return path;
}

/** Retention, mirroring `store.ts`'s `PRUNE_TTL_MS`/`MAX_TERMINAL_ROWS`: age first, then a
 *  hard cap on file count (oldest first). A salvage bundle is a rescue mechanism for a human
 *  to notice and act on, not an archive — this directory must not grow forever on a host that
 *  nobody is watching. */
const SALVAGE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_SALVAGE_FILES = 100;

/** Best-effort GC, run after every successful salvage write. Never throws — a pruning bug
 *  must not be the thing that makes a salvage attempt look like it failed. */
function pruneSalvageDir(): void {
  try {
    const root = salvageRoot();
    if (!existsSync(root)) return;
    const cutoff = Date.now() - SALVAGE_TTL_MS;
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(root, e.name))
      .map((p) => ({ path: p, mtimeMs: statSync(p).mtimeMs }));
    const kept: typeof entries = [];
    for (const e of entries) {
      if (e.mtimeMs < cutoff) {
        rmSync(e.path, { force: true });
      } else {
        kept.push(e);
      }
    }
    kept.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of kept.slice(MAX_SALVAGE_FILES)) {
      rmSync(stale.path, { force: true });
    }
  } catch {
    // best effort
  }
}

/**
 * Commits on `branch` reachable from nowhere else in the repo — i.e. not yet pushed and not
 * otherwise durable. `branch` must be excluded from its own negative set via `--exclude`:
 * without it, `--branches` always includes `branch` itself, and `<branch> --not --branches`
 * is trivially empty for every branch, always. Read in `main`, which shares `.git` with every
 * linked worktree, so the branch and every candidate "elsewhere" ref are both visible from
 * there without touching the worktree checkout itself.
 */
async function orphanCommitCount(main: string, branch: string): Promise<number> {
  const refs = await git(
    ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"],
    main,
  );
  if (!refs.ok) return 0;
  const elsewhere = refs.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== `refs/heads/${branch}`);
  const args = [
    "rev-list",
    "--count",
    branch,
    ...(elsewhere.length ? ["--not", ...elsewhere] : []),
  ];
  const r = await git(args, main);
  if (!r.ok) return 0;
  return Number.parseInt(r.stdout.trim(), 10) || 0;
}

/**
 * Bundle whatever a worktree carries that would otherwise vanish with it, before it is torn
 * down. Best effort end to end: every failure is caught and logged, and returns null — the
 * caller's teardown must proceed either way, salvage or no salvage.
 *
 * Two things can be lost: commits the episode made but never pushed (`orphanCommitCount`),
 * and edits it never committed at all. `git stash create` captures the latter as a plain
 * commit object without touching the stash ref list, so nothing about the worktree's normal
 * teardown changes; `git add -A` runs first because `stash create` — unlike `stash push` — has
 * no `--include-untracked`, and a new file the episode wrote is exactly the kind of edit worth
 * keeping. `git bundle create` then takes the branch tip and that stash commit as two positive
 * refs, which is what makes one bundle recover both halves in one shot.
 *
 * Returns null (no file written) when there is nothing to save. A clean worktree — the
 * ordinary case for a read tier that never wrote anything, and for any tier torn down after a
 * clean run — must not grow this directory.
 */
export async function salvageWorktree(
  main: string,
  path: string,
  branch: string,
): Promise<{ path: string; bytes: number } | null> {
  try {
    if (!existsSync(path)) return null;
    const orphaned = await orphanCommitCount(main, branch);

    await git(["add", "-A"], path, 30_000);
    const stashed = await git(["stash", "create"], path, 30_000);
    const dirtyCommit = stashed.ok ? stashed.stdout.trim() : "";

    if (orphaned === 0 && !dirtyCommit) return null;

    const root = salvageRoot();
    mkdirSync(root, { recursive: true });
    const bundlePath = join(root, `${branch.replace(/\//g, "-")}.bundle`);
    const refs = dirtyCommit ? [branch, dirtyCommit] : [branch];
    const bundled = await git(["bundle", "create", bundlePath, ...refs], main, 60_000);
    if (!bundled.ok || !existsSync(bundlePath)) {
      logger.warn(
        {
          event: "dispatch.worktree_salvage_failed",
          branch,
          error: bundled.stderr.trim().slice(0, 300),
        },
        "could not bundle a discarded worktree's work — proceeding with teardown",
      );
      return null;
    }
    const bytes = statSync(bundlePath).size;
    logger.warn(
      {
        event: "dispatch.worktree_salvaged",
        branch,
        path: bundlePath,
        bytes,
        orphanCommits: orphaned,
        dirty: !!dirtyCommit,
      },
      "salvaged a discarded worktree's work before teardown",
    );
    pruneSalvageDir();
    return { path: bundlePath, bytes };
  } catch (err) {
    logger.warn(
      { event: "dispatch.worktree_salvage_failed", branch, error: String(err) },
      "could not salvage a discarded worktree — proceeding with teardown",
    );
    return null;
  }
}

/**
 * Delete every worktree a previous process left behind. Call once at HTTP server boot.
 *
 * `runDispatch`'s `finally` tears its worktree down on every exit path *inside* the process,
 * and a SIGKILL has no exit path. That is not an exotic case: launchd restarts this server
 * on crash, and `make reload` kickstarts it deliberately, so a leftover is the ordinary
 * outcome of restarting during an episode. What leaks is not confined to this tool's own
 * state dir either — `git worktree add` registers itself in the LIVE repo and creates a
 * branch there, so the residue surfaces in the user's `git branch` and `git worktree list`.
 * Every tier takes a worktree now, including the high-volume read ones, so it accumulates.
 *
 * Each leftover is self-describing, which is why this needs no bookkeeping that would itself
 * have to survive the crash: a linked worktree's `.git` is a FILE reading
 * `gitdir: <main>/.git/worktrees/<id>`, naming the repo to clean up, and that gitdir's `HEAD`
 * names the branch. A leftover whose repo has since moved or been deleted still gets its
 * directory removed — the git calls are best effort and none of them throws.
 *
 * Safe to run unconditionally at boot because launchd keeps exactly one instance of this
 * server: at the moment it starts, no episode of its own is in flight, so every directory
 * under the root is by definition abandoned — UNLESS it belongs to a `running` dispatch row
 * boot recovery is about to resume rather than abandon (`protectedPaths`, below): that
 * directory is not a leftover, it's the next attempt's own worktree, still described by a
 * `session_id` on the job row. `server/index.ts` reads `protectedWorktreePaths()`
 * (`server/jobs/store.ts`) BEFORE `initJobStore()` runs its `recover()` and passes the result
 * here, ahead of `recover()` itself — see that call site for why the ordering matters.
 */
export async function sweepStaleWorktrees(protectedPaths: readonly string[] = []): Promise<number> {
  const root = worktreeRoot();
  if (!existsSync(root)) return 0;
  const protectedSet = new Set(protectedPaths);
  let swept = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (protectedSet.has(path)) continue;
    const { main, branch } = describeLeftover(path);
    if (main) {
      // Every leftover here is, by definition, from an abnormal exit — nothing at boot ever
      // reaches a worktree it tore down cleanly. Salvage before the discard it cannot prevent.
      await salvageWorktree(main, path, branch);
      await discardWorktree(main, path, branch);
    } else if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
    }
    swept++;
    logger.warn(
      { event: "dispatch.worktree_swept", path, project: main, branch },
      "removed a worktree left behind by a previous process",
    );
  }
  return swept;
}

/** Read a leftover worktree's own pointers to find the repo and branch it belongs to.
 *  Returns empty fields rather than throwing — a leftover too damaged to describe itself is
 *  still a directory worth deleting. */
function describeLeftover(path: string): { main: string; branch: string } {
  try {
    const gitdir = readFileSync(join(path, ".git"), "utf8")
      .trim()
      .replace(/^gitdir:\s*/, "");
    const main = gitdir.split("/.git/worktrees/")[0] ?? "";
    if (!main || !existsSync(join(main, ".git"))) return { main: "", branch: "" };
    const head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
    return { main, branch: head.replace(/^ref:\s*refs\/heads\//, "").trim() };
  } catch {
    return { main: "", branch: "" };
  }
}

// ── Repo-supplied session settings ────────────────────────────────────────────

/**
 * Settings files a session loads from the repo it runs in.
 *
 * Only the PROJECT ROOT's are honored — measured on CLI 2.1.220 (2026-08-03): a
 * `sub/.claude/settings.json` had no effect, so removing these two is sufficient rather than
 * merely helpful. `settings.local.json` is conventionally untracked and therefore absent from
 * a fresh worktree; it is listed anyway, because "conventionally" is not a guarantee.
 */
const PROJECT_SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"];

/**
 * Delete the repo's own session settings from the worktree, before the episode starts.
 *
 * `WORKER_SETTINGS` (session-runner) already disables hooks, and hooks were the obvious
 * vector. They are not the only one: measured on the same CLI, a project settings file's
 * `env` block **overrides the environment the handler supplied**. A repo containing
 *
 *     { "env": { "GIT_CONFIG_GLOBAL": "/repo/wins" } }
 *
 * gets exactly that inside the session's Bash — which is `GIT_DENY_CREDENTIALS_ENV`, the
 * overlay that takes git's push credential away from every tier, undone by one line in the
 * audited repo. `disableAllHooks` does nothing about it, and neither would any other flag
 * that keeps the project source loaded. So the file is removed instead, in the only place
 * that can do it without touching anything a human owns: the throwaway copy.
 *
 * Returns the paths removed, which the caller hands back to `restoreStrippedSettings`.
 */
export function stripProjectSettings(wt: DispatchWorktree): string[] {
  const stripped: string[] = [];
  for (const rel of PROJECT_SETTINGS_FILES) {
    const abs = join(wt.path, rel);
    if (!existsSync(abs)) continue;
    rmSync(abs, { force: true });
    stripped.push(rel);
  }
  if (stripped.length > 0) {
    logger.info(
      { event: "dispatch.settings_stripped", branch: wt.branch, files: stripped },
      "removed the repo's session settings from the worktree",
    );
  }
  return stripped;
}

/**
 * Put them back, before anything inspects or commits the tree.
 *
 * Without this the strip would read as a deletion: `commitPendingWork` stages with `add -A`,
 * so an implement episode would open a pull request that deletes the repo's `.claude/settings.json`.
 *
 * Restored from `wt.base` rather than from `HEAD`, so an episode that edited the file — or
 * committed an edit to it — ends up with the base version either way. That is deliberate and
 * narrow: the one file an episode may not change is the one that decides what executes in the
 * next episode. It is the same reason the CI surface is refused at push time.
 *
 * Only paths the base tree actually carries are checked out. A fresh worktree holds tracked
 * files only, so in practice every stripped path is one of them — but `git checkout <oid> --
 * <path>` FAILS on a path the commit does not contain, and that would turn the cleanup into
 * the thing that fails the episode. A stripped path absent from the base needs no restoring
 * anyway: `add -A` stages no deletion for a file git never knew about.
 */
export async function restoreStrippedSettings(
  wt: DispatchWorktree,
  stripped: readonly string[],
): Promise<void> {
  if (stripped.length === 0) return;
  const known = await gitOrThrow(["ls-tree", "--name-only", wt.base, "--", ...stripped], wt.path);
  const restorable = known.split("\n").filter(Boolean);
  if (restorable.length === 0) return;
  await gitOrThrow(["checkout", wt.base, "--", ...restorable], wt.path);
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

/**
 * Why this diff may not be pushed, or null if it may. Separated from the push so the handler
 * can report the reason in the verdict instead of failing the whole episode.
 *
 * Checks are ordered cheapest-first and short-circuit, which is not merely tidy: the content
 * scan reads the whole patch into memory, and it must not run for a diff the size ceiling is
 * about to reject anyway.
 */
export async function diffRefusalReason(
  wt: DispatchWorktree,
  diff: DiffSummary,
): Promise<string | null> {
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
  const secrets = await addedSecrets(wt);
  if (secrets.length > 0) {
    return `the change adds text matching ${secrets.join(", ")} — a dispatched episode must never commit a credential or an internal address to a branch that becomes a public, permanent artifact`;
  }
  return null;
}

/**
 * Secret-shaped strings the episode ADDED, by pattern name.
 *
 * The artifact scan (`assertNoSecrets`) covers the issue and PR *bodies*. It says nothing
 * about the code, and the code is the durable half: a branch pushed to a public repo is in
 * the timeline, the API and every mirror the moment it exists, and unlike a PR description
 * it cannot be edited away. An episode that "fixes" a broken config by inlining the value it
 * read is the ordinary, non-adversarial way this happens.
 *
 * It is the handler's scan and not the repo's `pre-commit` hook — which is also why the
 * commit is made with `--no-verify`. A hook is repo-controlled code, and an implement
 * episode may be running in a repo whose hook it has just rewritten; a check the audited
 * party supplies is not a check.
 *
 * ADDED lines only. A credential already committed in this repo is not this episode's doing,
 * and refusing on it would disable the tier in precisely the repo that needs a fix. The
 * corollary is a real limit: a secret this episode merely MOVES between files is invisible
 * here, because the addition matches something the base already contained.
 */
async function addedSecrets(wt: DispatchWorktree): Promise<string[]> {
  const patch = await gitOrThrow(["diff", "--no-renames", "-U0", `${wt.base}...HEAD`], wt.path);
  const added = patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n");
  return scanForSecrets(added);
}

/**
 * Push the episode's branch, and only it.
 *
 * Four refusals, all structural. A read tier's worktree is not pushable at all, and saying
 * so here means the guarantee holds even if a caller forgets it; the refspec is built here
 * and names exactly one branch, so there is no shape of worker output that turns this into a
 * push to another ref; the default-branch check is explicit rather than implied by the
 * refspec, because that is the invariant a reader needs to see stated; and the `dispatch/`
 * prefix means a push can only ever land in the namespace this tool owns. There is no force
 * flag anywhere — the branch is new, so a push that would need one is a bug worth failing on.
 */
export async function pushBranch(wt: DispatchWorktree, id: RepoIdentity): Promise<void> {
  if (!wt.pushable) {
    throw new Error(`refusing to push a read tier's throwaway worktree (${wt.branch})`);
  }
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
