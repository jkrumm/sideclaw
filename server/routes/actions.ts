import { Elysia, t } from "elysia";
import { startJob, getJob, subscribeToJob } from "../lib/chain-runner";
import { toContainerPath } from "../lib/workspace";

// ── Git operations ────────────────────────────────────────────────────────────

type GitOpResult = { ok: true } | { ok: false; error: string };

async function gitNewBranch(repoPath: string, name: string): Promise<GitOpResult> {
  // Fetch to get latest origin state
  Bun.spawnSync(["git", "-C", repoPath, "fetch", "--quiet", "origin"], { stderr: "ignore" });

  // Determine default branch
  const defaultBranch = gitDefaultBranch(repoPath);

  const result = Bun.spawnSync([
    "git", "-C", repoPath, "checkout", "-b", name, `origin/${defaultBranch}`,
  ]);
  if (result.exitCode !== 0) {
    return { ok: false, error: new TextDecoder().decode(result.stderr).trim() };
  }
  return { ok: true };
}

async function gitNewWorktree(repoPath: string, branch: string): Promise<GitOpResult> {
  // wtp add creates a new worktree + branch in the configured base_dir
  const result = Bun.spawnSync(["wtp", "add", branch], {
    cwd: repoPath,
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return { ok: false, error: new TextDecoder().decode(result.stderr).trim() };
  }
  return { ok: true };
}

async function gitPush(worktreePath: string): Promise<GitOpResult> {
  // Try normal push first; if no upstream, set it
  let result = Bun.spawnSync(["git", "-C", worktreePath, "push"], { stderr: "pipe" });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    if (stderr.includes("no upstream") || stderr.includes("set-upstream")) {
      const branch = gitCurrentBranch(worktreePath);
      if (branch) {
        result = Bun.spawnSync([
          "git", "-C", worktreePath, "push", "-u", "origin", branch,
        ], { stderr: "pipe" });
      }
    }
    if (result.exitCode !== 0) {
      return { ok: false, error: new TextDecoder().decode(result.stderr).trim() };
    }
  }
  return { ok: true };
}

async function gitRebase(worktreePath: string): Promise<GitOpResult> {
  Bun.spawnSync(["git", "-C", worktreePath, "fetch", "--quiet", "origin"], { stderr: "ignore" });
  const defaultBranch = gitDefaultBranch(worktreePath);
  const result = Bun.spawnSync([
    "git", "-C", worktreePath, "rebase", `origin/${defaultBranch}`,
  ], { stderr: "pipe" });
  if (result.exitCode !== 0) {
    const err = new TextDecoder().decode(result.stderr).trim();
    // Abort rebase on failure to leave clean state
    Bun.spawnSync(["git", "-C", worktreePath, "rebase", "--abort"], { stderr: "ignore" });
    return { ok: false, error: err || "Rebase failed — conflicts detected. Use Claude chain for assisted rebase." };
  }
  return { ok: true };
}

function gitDefaultBranch(repoPath: string): string {
  const result = Bun.spawnSync([
    "git", "-C", repoPath, "symbolic-ref", "refs/remotes/origin/HEAD",
  ], { stderr: "ignore" });
  if (result.exitCode === 0) {
    const ref = new TextDecoder().decode(result.stdout).trim();
    return ref.split("/").pop() ?? "main";
  }
  return "main";
}

function gitCurrentBranch(repoPath: string): string | null {
  const result = Bun.spawnSync([
    "git", "-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD",
  ], { stderr: "ignore" });
  if (result.exitCode !== 0) return null;
  return new TextDecoder().decode(result.stdout).trim() || null;
}

// ── Routes ────────────────────────────────────────────────────────────────────

export const actionsRoutes = new Elysia({ prefix: "/api/actions" })

  // Start a Claude skill chain job
  .post(
    "/chain",
    async ({ body, set }) => {
      const hostPath = toContainerPath(body.worktreePath);
      const jobId = await startJob(body.skill, hostPath);
      return { ok: true, jobId };
    },
    {
      body: t.Object({
        skill: t.String(),        // e.g. "/check" or "/pr create"
        worktreePath: t.String(), // display path e.g. "/SourceRoot/cbbi-blueprint"
      }),
    },
  )

  // SSE stream for a job
  .get("/chain/:id/stream", ({ params, set }) => {
    const stream = subscribeToJob(params.id);
    if (!stream) {
      set.status = 404;
      return { ok: false, error: "Job not found" };
    }
    set.headers["content-type"] = "text/event-stream";
    set.headers["cache-control"] = "no-cache";
    set.headers["x-accel-buffering"] = "no";
    return stream;
  })

  // Get job state
  .get("/chain/:id", ({ params, set }) => {
    const job = getJob(params.id);
    if (!job) {
      set.status = 404;
      return { ok: false, error: "Job not found" };
    }
    return { ok: true, data: job };
  })

  // Git operations (non-Claude, direct git/shell commands)
  .post(
    "/git",
    async ({ body, set }) => {
      const hostPath = toContainerPath(body.worktreePath);
      let result: GitOpResult;

      switch (body.op) {
        case "new-branch":
          if (!body.name) {
            set.status = 400;
            return { ok: false, error: "name required for new-branch" };
          }
          result = await gitNewBranch(hostPath, body.name);
          break;
        case "new-worktree":
          if (!body.name) {
            set.status = 400;
            return { ok: false, error: "name required for new-worktree" };
          }
          result = await gitNewWorktree(hostPath, body.name);
          break;
        case "push":
          result = await gitPush(hostPath);
          break;
        case "rebase":
          result = await gitRebase(hostPath);
          break;
        default:
          set.status = 400;
          return { ok: false, error: `Unknown op: ${body.op}` };
      }

      if (!result.ok) set.status = 422;
      return result;
    },
    {
      body: t.Object({
        op: t.Union([
          t.Literal("new-branch"),
          t.Literal("new-worktree"),
          t.Literal("push"),
          t.Literal("rebase"),
        ]),
        worktreePath: t.String(),
        name: t.Optional(t.String()),
      }),
    },
  );
