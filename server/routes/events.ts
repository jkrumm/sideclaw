import { Elysia, sse } from "elysia";
import { watch } from "fs";
import { existsSync } from "fs";
import { join } from "path";
import { toContainerPath } from "../lib/workspace";
import { subscribeDiagrams } from "../lib/diagram-bus";
import { getNotesWriteSource } from "../lib/notes-bus";

// Stable identity for this process lifetime.
// Clients compare this on reconnect — a change means the server restarted
// (new build deployed) and they should reload to pick up updated assets.
const SERVER_START = Date.now();

const HEARTBEAT_INTERVAL_MS = 20_000;

export const eventsRoutes = new Elysia({ prefix: "/api" }).get(
  "/events",
  async function* ({ query, request }) {
    const path = query.path;
    if (!path) {
      yield sse({ event: "error", data: JSON.stringify({ error: "Missing path" }) });
      return;
    }

    const containerPath = toContainerPath(path);
    const queuePath = join(containerPath, "sc-queue.md");
    const notesPath = join(containerPath, "sc-note.md");

    type PendingEvent =
      | { file: "queue" }
      | { file: "notes"; sourceTabId?: string }
      | { file: "diagram"; name: string; modifiedAt: number }
      | { file: "ping" };

    const pending: PendingEvent[] = [];
    let wake: (() => void) | null = null;
    let closed = false;

    const push = (event: PendingEvent) => {
      pending.push(event);
      wake?.();
      wake = null;
    };

    const watchers: ReturnType<typeof watch>[] = [];

    if (existsSync(queuePath)) {
      watchers.push(watch(queuePath, () => push({ file: "queue" })));
    }
    if (existsSync(notesPath)) {
      watchers.push(
        watch(notesPath, () => {
          const sourceTabId = getNotesWriteSource(notesPath);
          push({ file: "notes", sourceTabId: sourceTabId ?? undefined });
        }),
      );
    }

    const unsubDiagrams = subscribeDiagrams(path, (evt) => {
      push({ file: "diagram", name: evt.name, modifiedAt: evt.modifiedAt });
    });

    // Heartbeat — keeps the connection alive through proxies and lets clients
    // detect stale connections via a watchdog timer.
    const heartbeat = setInterval(() => {
      if (!closed) push({ file: "ping" });
    }, HEARTBEAT_INTERVAL_MS);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const w of watchers) w.close();
      unsubDiagrams();
      wake?.();
      wake = null;
    };

    request.signal.addEventListener("abort", cleanup);

    // Server identity in the handshake — clients reload on change (server restarted).
    yield sse({ event: "connected", data: JSON.stringify({ serverStart: SERVER_START }) });

    while (!request.signal.aborted) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });

      while (pending.length > 0) {
        const event = pending.shift()!;
        if (event.file === "ping") {
          yield sse({ event: "ping", data: "{}" });
        } else {
          yield sse({ event: "change", data: JSON.stringify(event) });
        }
      }
    }

    cleanup();
  },
);
