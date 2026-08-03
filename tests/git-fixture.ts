// A throwaway git universe for the dispatch tests: a bare repo standing in for `origin`, a
// live checkout pointed at it, and a private worktree root.
//
// The remote is a local bare repo rather than a mock, which is what makes `pushBranch`
// testable at all — the refspec, the fast-forward-only behaviour and "only this branch
// moved" are properties of the real git invocation, not of anything a stub could assert.
// Nothing here reaches the network, and no test touches a real repo or the real worktree
// root.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(
  cmd: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...(process.env as Record<string, string>), ...env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function git(args: string[], cwd: string): Promise<string> {
  const r = await run(["git", ...args], cwd);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.code}) in ${cwd}: ${r.stderr}`);
  }
  return r.stdout;
}

export class Fixture {
  constructor(
    /** Temp root holding everything below. */
    readonly root: string,
    /** The live checkout an episode is dispatched against. */
    readonly repo: string,
    /** Bare repo serving as `origin`. */
    readonly origin: string,
    /** This fixture's private SIDECLAW_WORKTREE_ROOT. */
    readonly worktrees: string,
  ) {}

  /** Write a file (creating parents) and return its repo-relative path. */
  write(relPath: string, contents: string, cwd = this.repo): string {
    const abs = join(cwd, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
    return relPath;
  }

  /** Stage everything and commit, in the live checkout unless told otherwise. */
  async commit(message: string, cwd = this.repo): Promise<string> {
    await git(["add", "-A"], cwd);
    await git(["commit", "--no-verify", "-q", "-m", message], cwd);
    return git(["rev-parse", "HEAD"], cwd);
  }

  /** Branches present in the bare origin, as `name` → sha. */
  async originRefs(): Promise<Record<string, string>> {
    const out = await git(
      ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"],
      this.origin,
    );
    const refs: Record<string, string> = {};
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [name, sha] = line.split(" ");
      if (name && sha) refs[name] = sha;
    }
    return refs;
  }

  /** Local branch names in the live checkout. */
  async localBranches(): Promise<string[]> {
    const out = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], this.repo);
    return out.split("\n").filter(Boolean);
  }

  /** Worktree paths git believes are registered, excluding the main checkout. */
  async linkedWorktrees(): Promise<string[]> {
    const out = await git(["worktree", "list", "--porcelain"], this.repo);
    return out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length))
      .filter((p) => realpathSync(p) !== realpathSync(this.repo));
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/**
 * Build the fixture. `master` exists in both the checkout and origin, carrying one commit.
 *
 * Identity and `core.hooksPath` are set repo-locally rather than inherited: a test must not
 * depend on the developer's global git config, and the hooks dir has to be a known-empty
 * place before a test deliberately installs a failing pre-commit hook into it.
 */
export async function makeFixture(): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sideclaw-dispatch-")));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  mkdirSync(origin);
  mkdirSync(repo);

  await git(["init", "--bare", "-b", "master", "--quiet", "."], origin);
  await git(["init", "-b", "master", "--quiet", "."], repo);
  await git(["config", "user.name", "test"], repo);
  await git(["config", "user.email", "test@example.invalid"], repo);
  await git(["config", "commit.gpgsign", "false"], repo);

  const fx = new Fixture(root, repo, origin, worktrees);
  fx.write("README.md", "# fixture\n");
  fx.write(
    "src/app.ts",
    Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n",
  );
  await fx.commit("init");
  await git(["remote", "add", "origin", origin], repo);
  await git(["push", "-q", "-u", "origin", "master"], repo);

  process.env.SIDECLAW_WORKTREE_ROOT = worktrees;
  return fx;
}
