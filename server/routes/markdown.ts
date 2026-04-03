import { Elysia } from "elysia";
import { join, resolve } from "path";
import { promises as fs } from "fs";
import { toContainerPath } from "../lib/workspace";
import { scanMarkdownFiles } from "../lib/markdown-scanner";

export const markdownRoutes = new Elysia({ prefix: "/api" })
  .get("/markdown-files", ({ query, set }) => {
    const path = query.path;
    if (!path) {
      set.status = 400;
      return { ok: false, error: "Missing path query parameter" } as const;
    }

    const containerPath = toContainerPath(path);
    const files = scanMarkdownFiles(containerPath);
    return { ok: true, data: files } as const;
  })
  .get("/markdown-file", async ({ query, set }) => {
    const path = query.path;
    const file = query.file;
    if (!path || !file) {
      set.status = 400;
      return { ok: false, error: "Missing path or file query parameter" } as const;
    }
    if (!file.endsWith(".md") || file.includes("..")) {
      set.status = 400;
      return { ok: false, error: "Invalid file path" } as const;
    }

    const containerPath = toContainerPath(path);
    const filePath = resolve(join(containerPath, file));
    if (!filePath.startsWith(resolve(containerPath))) {
      set.status = 400;
      return { ok: false, error: "Path traversal not allowed" } as const;
    }

    try {
      const content = await Bun.file(filePath).text();
      return { ok: true, data: content } as const;
    } catch {
      return { ok: true, data: "" } as const;
    }
  })
  .put("/markdown-file", async ({ query, body, set }) => {
    const path = query.path;
    const file = query.file;
    if (!path || !file) {
      set.status = 400;
      return { ok: false, error: "Missing path or file query parameter" } as const;
    }
    if (!file.endsWith(".md") || file.includes("..")) {
      set.status = 400;
      return { ok: false, error: "Invalid file path" } as const;
    }

    const b = body as { content?: string };
    if (!b || typeof b.content !== "string") {
      set.status = 400;
      return { ok: false, error: "Body must be { content: string }" } as const;
    }

    const containerPath = toContainerPath(path);
    const filePath = resolve(join(containerPath, file));
    if (!filePath.startsWith(resolve(containerPath))) {
      set.status = 400;
      return { ok: false, error: "Path traversal not allowed" } as const;
    }

    const tmpPath = `${filePath}.tmp`;
    await Bun.write(tmpPath, b.content);
    await fs.rename(tmpPath, filePath);

    return { ok: true } as const;
  });
