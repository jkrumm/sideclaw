import { basename } from "path";

interface Workspace {
  name: string; // "SourceRoot" — derived from env var basename
  root: string; // host path: "/Users/johannes.krumm/SourceRoot"
}

function buildWorkspaces(): Workspace[] {
  return [process.env.PERSONAL_REPOS_PATH, process.env.WORK_REPOS_PATH]
    .filter((p): p is string => !!p)
    .map((p) => ({ name: basename(p), root: p }));
}

const WORKSPACES: Workspace[] = buildWorkspaces();

/** "/Users/.../SourceRoot/vps" → "/SourceRoot/vps" */
export function toDisplayPath(hostPath: string): string {
  for (const ws of WORKSPACES) {
    if (hostPath.startsWith(ws.root + "/")) {
      return "/" + ws.name + hostPath.slice(ws.root.length);
    }
  }
  return hostPath;
}

/** "/SourceRoot/vps" → "/Users/.../SourceRoot/vps" */
export function toContainerPath(displayPath: string): string {
  for (const ws of WORKSPACES) {
    if (displayPath.startsWith("/" + ws.name + "/")) {
      return ws.root + displayPath.slice(ws.name.length + 1);
    }
  }
  return displayPath;
}

/** Host roots to scan — e.g. ["/Users/.../SourceRoot", "/Users/.../IuRoot"] */
export const WORKSPACE_ROOTS = WORKSPACES.map((ws) => ws.root);
