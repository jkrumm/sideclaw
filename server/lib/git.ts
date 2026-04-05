export interface GitFile {
  status: "M" | "A" | "D" | "?" | "R";
  path: string;
  staged: boolean;
}

export interface GitCommit {
  sha: string;
  subject: string;
  body: string;
  relativeTime: string;
}

export interface Worktree {
  path: string;
  branch: string;
  isMain: boolean;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  insertions: number;
  deletions: number;
  stagedCount: number;
  mainBranch: string;
  changedFiles: GitFile[];
  branchCommits: GitCommit[];
  masterCommits: GitCommit[];
  worktrees: Worktree[];
  stashCount: number;
  lastTag: string | null;
  distanceFromTag: number;
  remoteUrl: string | null;
  githubRepo: string | null;
}

async function runGit(
  args: string[],
  opts: { raw?: boolean; timeoutMs?: number } = {},
): Promise<string | null> {
  const proc = Bun.spawn(["git", ...args], { stderr: "ignore", stdout: "pipe" });

  let killed = false;
  const timer =
    opts.timeoutMs != null
      ? setTimeout(() => {
          killed = true;
          proc.kill();
        }, opts.timeoutMs)
      : null;

  try {
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (timer) clearTimeout(timer);
    if (killed || exitCode !== 0) return null;
    return opts.raw ? text : text.trim();
  } catch {
    if (timer) clearTimeout(timer);
    return null;
  }
}

function parseGithubRepo(remoteUrl: string): string | null {
  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1] ?? null;
  const sshMatch = remoteUrl.match(/github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1] ?? null;
  return null;
}

function parseChangedFiles(output: string | null): GitFile[] {
  if (!output) return [];
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const x = line[0] ?? " ";
      const y = line[1] ?? " ";
      const path = line.slice(3);
      const staged = x !== " " && x !== "?";
      const relevantChar = staged ? x : y;
      let status: GitFile["status"] = "?";
      if (relevantChar === "M") status = "M";
      else if (relevantChar === "A") status = "A";
      else if (relevantChar === "D") status = "D";
      else if (relevantChar === "R") status = "R";
      return { status, path, staged };
    });
}

const LOG_SEP = "---GITRECORD---";

function parseCommits(output: string | null): GitCommit[] {
  if (!output) return [];
  return output
    .split(`\n${LOG_SEP}`)
    .map((r) => r.trim())
    .filter((r) => r && r !== LOG_SEP)
    .map((record) => {
      const lines = record.split("\n");
      return {
        sha: lines[0]?.trim() ?? "",
        subject: lines[1]?.trim() ?? "",
        relativeTime: lines[2]?.trim() ?? "",
        body: lines.slice(3).join("\n").trim(),
      };
    })
    .filter((c) => c.sha);
}

export async function getGitStatus(repoPath: string): Promise<GitStatus | null> {
  const g = (args: string[], opts?: { raw?: boolean; timeoutMs?: number }) =>
    runGit(["-C", repoPath, ...args], opts);

  // Phase 1 — all independent, run in parallel (fetch included)
  const [
    ,
    // fetch — side effect only, updates remote tracking refs
    branch,
    shortstat,
    stagedOutput,
    symbolicRef,
    statusOutput,
    stashOutput,
    lastTag,
    worktreeOutput,
    remoteUrl,
  ] = await Promise.all([
    g(["fetch", "--quiet", "--prune"], { timeoutMs: 5_000 }),
    g(["rev-parse", "--abbrev-ref", "HEAD"]),
    g(["diff", "--shortstat"]),
    g(["diff", "--cached", "--name-only"]),
    g(["symbolic-ref", "refs/remotes/origin/HEAD"]),
    g(["status", "--porcelain"], { raw: true }),
    g(["stash", "list"]),
    g(["describe", "--tags", "--abbrev=0"]),
    g(["worktree", "list", "--porcelain"]),
    g(["remote", "get-url", "origin"]),
  ]);

  if (!branch) return null;

  const mainBranch = symbolicRef ? (symbolicRef.split("/").pop() ?? "main") : "main";

  // Phase 2 — depend on phase 1 results, run in parallel
  const [aheadBehind, logOutput, masterLogOutput, distStr] = await Promise.all([
    g(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
    g(["log", `${mainBranch}..HEAD`, `--format=%h%n%s%n%ar%n%b%n${LOG_SEP}`, "--"]),
    g(["log", mainBranch, "-n", "10", `--format=%h%n%s%n%ar%n%b%n${LOG_SEP}`, "--"]),
    lastTag ? g(["rev-list", `${lastTag}..HEAD`, "--count"]) : Promise.resolve(null),
  ]);

  // Parse ahead/behind
  let ahead = 0;
  let behind = 0;
  if (aheadBehind) {
    const parts = aheadBehind.split(/\s+/);
    ahead = parseInt(parts[0] ?? "0", 10) || 0;
    behind = parseInt(parts[1] ?? "0", 10) || 0;
  }

  // Parse diff shortstat
  let insertions = 0;
  let deletions = 0;
  if (shortstat) {
    insertions = parseInt(shortstat.match(/(\d+) insertion/)?.[1] ?? "0", 10) || 0;
    deletions = parseInt(shortstat.match(/(\d+) deletion/)?.[1] ?? "0", 10) || 0;
  }

  const stagedCount =
    stagedOutput && stagedOutput.length > 0 ? stagedOutput.split("\n").filter(Boolean).length : 0;

  const changedFiles = parseChangedFiles(statusOutput);
  const branchCommits = parseCommits(logOutput);
  const masterCommits = parseCommits(masterLogOutput);
  const stashCount = stashOutput ? stashOutput.split("\n").filter(Boolean).length : 0;
  const distanceFromTag = distStr ? parseInt(distStr, 10) || 0 : 0;

  // Parse worktrees
  const worktrees: Worktree[] = [];
  if (worktreeOutput) {
    const blocks = worktreeOutput.split("\n\n").filter(Boolean);
    const mainWorktreePath = blocks[0]?.match(/^worktree (.+)/m)?.[1] ?? null;
    for (const block of blocks) {
      const pathMatch = block.match(/^worktree (?<path>.+)/m);
      const branchMatch = block.match(/^branch refs\/heads\/(?<branch>.+)/m);
      if (pathMatch?.groups && branchMatch?.groups) {
        worktrees.push({
          path: pathMatch.groups.path,
          branch: branchMatch.groups.branch,
          isMain: pathMatch.groups.path === mainWorktreePath,
        });
      }
    }
  }

  const githubRepo = remoteUrl ? parseGithubRepo(remoteUrl) : null;

  return {
    branch,
    ahead,
    behind,
    insertions,
    deletions,
    stagedCount,
    mainBranch,
    changedFiles,
    branchCommits,
    masterCommits,
    worktrees,
    stashCount,
    lastTag,
    distanceFromTag,
    remoteUrl,
    githubRepo,
  };
}
