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

function run(args: string[]): string | null {
  try {
    const result = Bun.spawnSync(["git", ...args], { stderr: "ignore" });
    if (result.exitCode !== 0) return null;
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    return null;
  }
}

// Like run() but without trimming — needed for git status --porcelain where
// leading spaces are meaningful status characters (unstaged file indicator).
function runRaw(args: string[]): string | null {
  try {
    const result = Bun.spawnSync(["git", ...args], { stderr: "ignore" });
    if (result.exitCode !== 0) return null;
    return new TextDecoder().decode(result.stdout);
  } catch {
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

export function getGitStatus(repoPath: string): GitStatus | null {
  // Update remote tracking refs so ahead/behind, tags, and history are current
  run(["-C", repoPath, "fetch", "--quiet", "--prune"]);

  const branch = run(["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return null;

  let ahead = 0;
  let behind = 0;
  const aheadBehind = run([
    "-C",
    repoPath,
    "rev-list",
    "--left-right",
    "--count",
    "HEAD...@{upstream}",
  ]);
  if (aheadBehind) {
    const parts = aheadBehind.split(/\s+/);
    ahead = parseInt(parts[0] ?? "0", 10) || 0;
    behind = parseInt(parts[1] ?? "0", 10) || 0;
  }

  let insertions = 0;
  let deletions = 0;
  const shortstat = run(["-C", repoPath, "diff", "--shortstat"]);
  if (shortstat) {
    const insMatch = shortstat.match(/(\d+) insertion/);
    const delMatch = shortstat.match(/(\d+) deletion/);
    insertions = insMatch ? parseInt(insMatch[1], 10) : 0;
    deletions = delMatch ? parseInt(delMatch[1], 10) : 0;
  }

  const stagedOutput = run(["-C", repoPath, "diff", "--cached", "--name-only"]);
  const stagedCount =
    stagedOutput && stagedOutput.length > 0
      ? stagedOutput.split("\n").filter(Boolean).length
      : 0;

  // Main branch detection
  const symbolicRef = run([
    "-C",
    repoPath,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
  ]);
  const mainBranch = symbolicRef
    ? (symbolicRef.split("/").pop() ?? "main")
    : "main";

  // Changed files — use runRaw to preserve leading spaces (unstaged status chars)
  const statusOutput = runRaw(["-C", repoPath, "status", "--porcelain"]);
  const changedFiles = parseChangedFiles(statusOutput);

  // Commits on branch vs main
  const logOutput = run([
    "-C",
    repoPath,
    "log",
    `${mainBranch}..HEAD`,
    `--format=%h%n%s%n%ar%n%b%n${LOG_SEP}`,
    "--",
  ]);
  const branchCommits = parseCommits(logOutput);

  // Stash count
  const stashOutput = run(["-C", repoPath, "stash", "list"]);
  const stashCount = stashOutput
    ? stashOutput.split("\n").filter(Boolean).length
    : 0;

  // Last tag
  const lastTag = run(["-C", repoPath, "describe", "--tags", "--abbrev=0"]);
  let distanceFromTag = 0;
  if (lastTag) {
    const distStr = run([
      "-C",
      repoPath,
      "rev-list",
      `${lastTag}..HEAD`,
      "--count",
    ]);
    distanceFromTag = distStr ? parseInt(distStr, 10) || 0 : 0;
  }

  // Recent commits on main branch
  const masterLogOutput = run([
    "-C",
    repoPath,
    "log",
    mainBranch,
    "-n",
    "10",
    `--format=%h%n%s%n%ar%n%b%n${LOG_SEP}`,
    "--",
  ]);
  const masterCommits = parseCommits(masterLogOutput);

  // Worktrees
  const worktreeOutput = run(["-C", repoPath, "worktree", "list", "--porcelain"]);
  const worktrees: Worktree[] = [];
  if (worktreeOutput) {
    const blocks = worktreeOutput.split("\n\n").filter(Boolean);
    const mainWorktreePath = blocks[0]?.match(/^worktree (.+)/m)?.[1] ?? null;
    for (const block of blocks) {
      const pathMatch = block.match(/^worktree (.+)/m);
      const branchMatch = block.match(/^branch refs\/heads\/(.+)/m);
      if (pathMatch && branchMatch) {
        worktrees.push({
          path: pathMatch[1]!,
          branch: branchMatch[1]!,
          isMain: pathMatch[1] === mainWorktreePath,
        });
      }
    }
  }

  // Remote URL + GitHub repo
  const remoteUrl = run(["-C", repoPath, "remote", "get-url", "origin"]);
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
