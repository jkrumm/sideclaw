import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { WORKSPACE_ROOTS, toDisplayPath } from "./workspace";

export interface RepoInfo {
  name: string;
  path: string; // display path: "/SourceRoot/vps"
  containerPath: string; // host path: "/Users/.../SourceRoot/vps"
  hasQueue: boolean;
  hasNotes: boolean;
}

export function scanRepos(): RepoInfo[] {
  const repos: RepoInfo[] = [];

  for (const root of WORKSPACE_ROOTS) {
    if (!existsSync(root)) continue;

    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const repoPath = join(root, entry);
      try {
        if (!statSync(repoPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const hasQueue = existsSync(join(repoPath, "sc-queue.md"));
      const hasNotes = existsSync(join(repoPath, "sc-note.md"));

      if (!hasQueue && !hasNotes) continue;

      repos.push({
        name: entry,
        path: toDisplayPath(repoPath),
        containerPath: repoPath,
        hasQueue,
        hasNotes,
      });
    }
  }

  return repos;
}
