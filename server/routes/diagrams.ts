import { Elysia } from "elysia";
import { join, resolve } from "path";
import { promises as fs } from "fs";
import { toContainerPath } from "../lib/workspace";
import { publishDiagram } from "../lib/diagram-bus";
import {
  acquireLock,
  heartbeatLock,
  releaseLock,
  validateLock,
  getLockAge,
} from "../lib/diagram-lock";

const DIAGRAMS_DIR = "docs/diagrams";

function diagramsDir(repoContainerPath: string): string {
  return join(repoContainerPath, DIAGRAMS_DIR);
}

function sanitizeName(name: string): string | null {
  if (!name || name.length > 100) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) return null;
  if (!/^[a-zA-Z0-9 \-_]+$/.test(trimmed)) return null;
  return trimmed;
}

export interface DiagramMeta {
  name: string;
  hasSvg: boolean;
  modifiedAt: number;
}

export const diagramsRoutes = new Elysia({ prefix: "/api" })
  // List all diagrams in docs/diagrams/
  .get("/diagrams", async ({ query, set }) => {
    const path = query.path;
    if (!path) {
      set.status = 400;
      return { ok: false, error: "Missing path" } as const;
    }

    const dir = diagramsDir(toContainerPath(path));

    try {
      await fs.mkdir(dir, { recursive: true });
      const entries = await fs.readdir(dir);
      const diagrams: DiagramMeta[] = [];

      for (const entry of entries) {
        if (!entry.endsWith(".excalidraw")) continue;
        const name = entry.slice(0, -".excalidraw".length);
        const svgPath = join(dir, `${name}.svg`);
        let hasSvg = false;
        let modifiedAt = 0;

        try {
          const stat = await fs.stat(join(dir, entry));
          modifiedAt = stat.mtimeMs;
          await fs.access(svgPath);
          hasSvg = true;
        } catch {
          // file may not exist yet
        }

        diagrams.push({ name, hasSvg, modifiedAt });
      }

      diagrams.sort((a, b) => b.modifiedAt - a.modifiedAt);
      return { ok: true, data: diagrams } as const;
    } catch {
      return { ok: true, data: [] as DiagramMeta[] } as const;
    }
  })

  // Get .excalidraw file content
  .get("/diagrams/file", async ({ query, set }) => {
    const { path, name } = query;
    if (!path || !name) {
      set.status = 400;
      return { ok: false, error: "Missing path or name" } as const;
    }

    const safeName = sanitizeName(name);
    if (!safeName) {
      set.status = 400;
      return { ok: false, error: "Invalid diagram name" } as const;
    }

    const dir = diagramsDir(toContainerPath(path));
    const filePath = resolve(join(dir, `${safeName}.excalidraw`));
    if (!filePath.startsWith(resolve(dir))) {
      set.status = 400;
      return { ok: false, error: "Path traversal not allowed" } as const;
    }

    try {
      const [content, stat] = await Promise.all([
        Bun.file(filePath).text(),
        fs.stat(filePath),
      ]);
      return { ok: true, data: content, modifiedAt: stat.mtimeMs } as const;
    } catch {
      return { ok: true, data: "", modifiedAt: 0 } as const;
    }
  })

  // Save .excalidraw + .svg — requires a valid lock token for existing files.
  // New files (first save) bypass the lock check since there is no concurrent
  // edit risk for files that do not yet exist.
  .put("/diagrams/file", async ({ query, body, request, set }) => {
    const { path, name } = query;
    if (!path || !name) {
      set.status = 400;
      return { ok: false, error: "Missing path or name" } as const;
    }

    const safeName = sanitizeName(name);
    if (!safeName) {
      set.status = 400;
      return { ok: false, error: "Invalid diagram name" } as const;
    }

    const b = body as { excalidraw?: string; svg?: string };
    if (!b || typeof b.excalidraw !== "string") {
      set.status = 400;
      return { ok: false, error: "Body must include excalidraw string" } as const;
    }

    const dir = diagramsDir(toContainerPath(path));
    await fs.mkdir(dir, { recursive: true });

    const excalidrawPath = resolve(join(dir, `${safeName}.excalidraw`));
    if (!excalidrawPath.startsWith(resolve(dir))) {
      set.status = 400;
      return { ok: false, error: "Path traversal not allowed" } as const;
    }

    // Lock enforcement: if the file already exists, the caller must hold the lock.
    const fileExists = await fs.access(excalidrawPath).then(() => true).catch(() => false);
    if (fileExists) {
      const lockToken = request.headers.get("x-lock-token");
      if (!lockToken || !validateLock(path, safeName, lockToken)) {
        set.status = 403;
        return { ok: false, error: "lock_required" } as const;
      }
    }

    const tmpExcalidraw = `${excalidrawPath}.tmp`;
    await Bun.write(tmpExcalidraw, b.excalidraw);
    await fs.rename(tmpExcalidraw, excalidrawPath);

    if (typeof b.svg === "string" && b.svg.length > 0) {
      const svgPath = resolve(join(dir, `${safeName}.svg`));
      const tmpSvg = `${svgPath}.tmp`;
      await Bun.write(tmpSvg, b.svg);
      await fs.rename(tmpSvg, svgPath);
    }

    const newStat = await fs.stat(excalidrawPath);
    const modifiedAt = newStat.mtimeMs;

    publishDiagram(path, { name: safeName, modifiedAt });

    return { ok: true, modifiedAt } as const;
  })

  // Delete .excalidraw + .svg pair
  .delete("/diagrams/file", async ({ query, set }) => {
    const { path, name } = query;
    if (!path || !name) {
      set.status = 400;
      return { ok: false, error: "Missing path or name" } as const;
    }

    const safeName = sanitizeName(name);
    if (!safeName) {
      set.status = 400;
      return { ok: false, error: "Invalid diagram name" } as const;
    }

    const dir = diagramsDir(toContainerPath(path));
    const excalidrawPath = resolve(join(dir, `${safeName}.excalidraw`));
    if (!excalidrawPath.startsWith(resolve(dir))) {
      set.status = 400;
      return { ok: false, error: "Path traversal not allowed" } as const;
    }

    await fs.unlink(excalidrawPath).catch(() => {});
    await fs.unlink(resolve(join(dir, `${safeName}.svg`))).catch(() => {});

    return { ok: true } as const;
  })

  // Rename .excalidraw + .svg pair
  .post("/diagrams/rename", async ({ query, body, set }) => {
    const { path } = query;
    const b = body as { name?: string; newName?: string };
    if (!path || !b?.name || !b?.newName) {
      set.status = 400;
      return { ok: false, error: "Missing path, name, or newName" } as const;
    }

    const safeName = sanitizeName(b.name);
    const safeNewName = sanitizeName(b.newName);
    if (!safeName || !safeNewName) {
      set.status = 400;
      return { ok: false, error: "Invalid diagram name" } as const;
    }

    const dir = diagramsDir(toContainerPath(path));
    const resolvedDir = resolve(dir);

    const oldExcalidraw = resolve(join(dir, `${safeName}.excalidraw`));
    const newExcalidraw = resolve(join(dir, `${safeNewName}.excalidraw`));
    if (!oldExcalidraw.startsWith(resolvedDir) || !newExcalidraw.startsWith(resolvedDir)) {
      set.status = 400;
      return { ok: false, error: "Path traversal not allowed" } as const;
    }

    await fs.rename(oldExcalidraw, newExcalidraw).catch(() => {});
    await fs.rename(
      resolve(join(dir, `${safeName}.svg`)),
      resolve(join(dir, `${safeNewName}.svg`)),
    ).catch(() => {});

    return { ok: true } as const;
  })

  // Serve SVG file for thumbnails (returns SVG with correct content-type)
  .get("/diagrams/svg", async ({ query, set }) => {
    const { path, name } = query;
    if (!path || !name) {
      set.status = 400;
      return "Missing path or name";
    }

    const safeName = sanitizeName(name);
    if (!safeName) {
      set.status = 400;
      return "Invalid name";
    }

    const dir = diagramsDir(toContainerPath(path));
    const svgPath = resolve(join(dir, `${safeName}.svg`));
    if (!svgPath.startsWith(resolve(dir))) {
      set.status = 400;
      return "Path traversal not allowed";
    }

    try {
      const content = await Bun.file(svgPath).text();
      set.headers["content-type"] = "image/svg+xml";
      set.headers["cache-control"] = "no-cache";
      return content;
    } catch {
      set.status = 404;
      return "Not found";
    }
  })

  // ── Pessimistic edit lock ────────────────────────────────────────────────────
  //
  // Locks are per-diagram (repoPath + name). TTL = 45s, heartbeat every 15s.
  // Only the lock holder may write via PUT /diagrams/file (enforced by X-Lock-Token).

  // Acquire lock — returns token on success, 423 if locked by another session.
  .post("/diagrams/lock", ({ query, set }) => {
    const { path, name } = query;
    if (!path || !name) {
      set.status = 400;
      return { ok: false, error: "Missing path or name" } as const;
    }
    const safeName = sanitizeName(name);
    if (!safeName) {
      set.status = 400;
      return { ok: false, error: "Invalid diagram name" } as const;
    }

    const token = acquireLock(path, safeName);
    if (!token) {
      set.status = 423;
      return { ok: false, lockedAgoMs: getLockAge(path, safeName) ?? 0 } as const;
    }
    return { ok: true, token } as const;
  })

  // Heartbeat — extend TTL. Returns 401 if token is invalid or lock has expired.
  .post("/diagrams/lock/heartbeat", ({ query, set }) => {
    const { path, name, token } = query;
    if (!path || !name || !token) {
      set.status = 400;
      return { ok: false, error: "Missing path, name, or token" } as const;
    }
    const safeName = sanitizeName(name);
    if (!safeName) {
      set.status = 400;
      return { ok: false, error: "Invalid diagram name" } as const;
    }

    if (!heartbeatLock(path, safeName, token)) {
      set.status = 401;
      return { ok: false, error: "Lock expired or invalid token" } as const;
    }
    return { ok: true } as const;
  })

  // Release lock — idempotent. Safe to call even if lock has already expired.
  // Also used as the sendBeacon target on page unload (POST with token in query).
  .post("/diagrams/lock/release", ({ query }) => {
    const { path, name, token } = query;
    if (path && name && token) {
      const safeName = sanitizeName(name);
      if (safeName) releaseLock(path, safeName, token);
    }
    // Always 200 — release is idempotent
    return { ok: true } as const;
  });
