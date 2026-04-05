import { Elysia } from "elysia";
import { join } from "path";
import { promises as fs } from "fs";
import { toContainerPath } from "../lib/workspace";
import { recordNotesWrite } from "../lib/notes-bus";

export const notesRoutes = new Elysia({ prefix: "/api" })
  .get("/notes", async ({ query, set }) => {
    const path = query.path;
    if (!path) {
      set.status = 400;
      return { ok: false, error: "Missing path query parameter" } as const;
    }

    const notesPath = join(toContainerPath(path), "sc-note.md");

    try {
      const [content, stat] = await Promise.all([Bun.file(notesPath).text(), fs.stat(notesPath)]);
      return { ok: true, data: content, modifiedAt: stat.mtimeMs } as const;
    } catch {
      return { ok: true, data: "", modifiedAt: 0 } as const;
    }
  })
  .put("/notes", async ({ query, body, set }) => {
    const path = query.path;
    if (!path) {
      set.status = 400;
      return { ok: false, error: "Missing path query parameter" } as const;
    }

    const b = body as { content?: string };
    if (!b || typeof b.content !== "string") {
      set.status = 400;
      return { ok: false, error: "Body must be { content: string }" } as const;
    }

    const notesPath = join(toContainerPath(path), "sc-note.md");
    const tabId = query.tabId as string | undefined;
    const clientModifiedAt = query.modifiedAt ? Number(query.modifiedAt) : null;

    // Conflict check: if client provided a modifiedAt, verify the file hasn't
    // changed since they loaded it. clientModifiedAt=0 means first save — skip.
    if (clientModifiedAt) {
      try {
        const stat = await fs.stat(notesPath);
        if (stat.mtimeMs > clientModifiedAt) {
          set.status = 409;
          return { ok: false, error: "conflict" } as const;
        }
      } catch {
        // File doesn't exist yet — first write, no conflict possible
      }
    }

    const tmpPath = `${notesPath}.tmp`;

    if (tabId) recordNotesWrite(notesPath, tabId);

    await Bun.write(tmpPath, b.content);
    await fs.rename(tmpPath, notesPath);

    const stat = await fs.stat(notesPath);
    return { ok: true, modifiedAt: stat.mtimeMs } as const;
  });
