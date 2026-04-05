import { Elysia, t } from "elysia";
import { existsSync, readdirSync, statSync } from "fs";
import { promises as fs } from "fs";
import { join } from "path";
import { scanRepos } from "../lib/repo-scanner";
import { parseQueue } from "../lib/parse-queue";
import { getGitStatus } from "../lib/git";
import { toContainerPath, toDisplayPath, WORKSPACES } from "../lib/workspace";

async function ensureFile(filePath: string): Promise<string> {
  if (!existsSync(filePath)) {
    await Bun.write(filePath, "");
  }
  return Bun.file(filePath).text();
}

export const reposRoutes = new Elysia({ prefix: "/api" })
  .get("/repos", () => {
    const repos = scanRepos();
    return { ok: true, data: repos };
  })
  .get("/workspaces", () => {
    return { ok: true, data: WORKSPACES.map((ws) => ({ name: ws.name, root: ws.root })) };
  })
  .get("/repos/candidates", () => {
    const tracked = new Set(scanRepos().map((r) => r.containerPath));
    const candidates: { name: string; workspace: string }[] = [];
    for (const ws of WORKSPACES) {
      if (!existsSync(ws.root)) continue;
      let entries: string[];
      try { entries = readdirSync(ws.root); } catch { continue; }
      for (const entry of entries) {
        const repoPath = join(ws.root, entry);
        try { if (!statSync(repoPath).isDirectory()) continue; } catch { continue; }
        if (tracked.has(repoPath)) continue;
        if (!existsSync(join(repoPath, ".git"))) continue;
        candidates.push({ name: entry, workspace: ws.name });
      }
    }
    return { ok: true, data: candidates };
  })
  .post(
    "/repos/init",
    async ({ body, set }) => {
      const { name, workspace } = body;
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
        set.status = 400;
        return { ok: false as const, error: "Invalid repo name" };
      }
      const ws = WORKSPACES.find((w) => w.name === workspace);
      if (!ws) {
        set.status = 400;
        return { ok: false as const, error: "Unknown workspace" };
      }
      const repoPath = join(ws.root, name);
      if (!existsSync(repoPath)) {
        await fs.mkdir(repoPath, { recursive: true });
      }
      await Bun.write(join(repoPath, "sc-queue.md"), "");
      await Bun.write(join(repoPath, "sc-note.md"), `# ${name} — Notes\n`);
      return { ok: true as const, data: { name, path: toDisplayPath(repoPath) } };
    },
    { body: t.Object({ name: t.String(), workspace: t.String() }) },
  )
  .delete("/repos/remove", async ({ query, set }) => {
    const { path } = query;
    if (!path) {
      set.status = 400;
      return { ok: false, error: "Missing path" };
    }
    const containerPath = toContainerPath(path);
    if (!existsSync(containerPath)) {
      set.status = 404;
      return { ok: false, error: "Repo not found" };
    }
    const queuePath = join(containerPath, "sc-queue.md");
    const notesPath = join(containerPath, "sc-note.md");
    if (existsSync(queuePath)) await fs.rm(queuePath);
    if (existsSync(notesPath)) await fs.rm(notesPath);
    return { ok: true };
  })
  .get("/repo/git", async ({ query, set }) => {
    const path = query.path;
    if (!path) {
      set.status = 400;
      return { ok: false, error: "Missing path query parameter" };
    }

    const containerPath = toContainerPath(path);
    const git = await getGitStatus(containerPath);

    // Normalise worktree paths to display paths so frontend can pass them back
    // to API endpoints directly (e.g. /api/actions/chain { worktreePath })
    if (git) {
      git.worktrees = git.worktrees.map((wt) => ({
        ...wt,
        path: toDisplayPath(wt.path),
      }));
    }

    return { ok: true, data: git };
  })
  .get("/repo", async ({ query, set }) => {
    const path = query.path;
    if (!path) {
      set.status = 400;
      return { ok: false, error: "Missing path query parameter" };
    }

    const containerPath = toContainerPath(path);
    const queuePath = join(containerPath, "sc-queue.md");
    const notesPath = join(containerPath, "sc-note.md");

    const [queueRaw, notes, notesStat] = await Promise.all([
      ensureFile(queuePath),
      ensureFile(notesPath),
      fs.stat(notesPath).catch(() => null),
    ]);

    const queue = parseQueue(queueRaw);

    const repo = {
      name: path.split("/").pop() ?? path,
      path,
      containerPath,
      hasQueue: existsSync(queuePath),
      hasNotes: existsSync(notesPath),
    };

    const notesModifiedAt = notesStat?.mtimeMs ?? 0;
    return { ok: true, data: { repo, queue, notes, notesModifiedAt } };
  });
