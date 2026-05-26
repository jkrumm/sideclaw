import { tmpdir } from "node:os";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { findChrome } from "./chrome.ts";
import { logger } from "../mcp/logger.ts";

export interface HydrateInput {
  skeleton: unknown[];
}

export interface HydrateResult {
  file: {
    type: "excalidraw";
    version: 2;
    source: string;
    elements: unknown[];
    appState: Record<string, unknown>;
    files: Record<string, unknown>;
  };
  viewport: { x: number; y: number; width: number; height: number } | null;
  deletedIds: string[];
  elementCount: number;
}

const BUNDLED_HTML_DATA_URL = (() => {
  const html =
    `<!doctype html>` +
    `<html><head><meta charset="utf-8"><title>hydrate</title></head>` +
    `<body>` +
    `<script type="module">` +
    `import { convertToExcalidrawElements, serializeAsJSON } from "https://esm.sh/@excalidraw/excalidraw@0.18.0?bundle";` +
    `window.__hydrate = async (skeleton) => {` +
    `  const elements = convertToExcalidrawElements(skeleton, { regenerateIds: false });` +
    `  const appState = { gridSize: null, viewBackgroundColor: "#ffffff" };` +
    `  const files = {};` +
    `  const json = serializeAsJSON(elements, appState, files, "local");` +
    `  return JSON.parse(json);` +
    `};` +
    `window.__ready = true;` +
    `</script>` +
    `</body></html>`;

  const base64 = Buffer.from(html, "utf-8").toString("base64");
  return `data:text/html;base64,${base64}`;
})();

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

interface CdpClient {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  on: (method: string, handler: (params: unknown) => void) => void;
  off: (method: string, handler: (params: unknown) => void) => void;
  close: () => void;
}

function createCdpClient(wsUrl: string): CdpClient {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Array<(params: unknown) => void>>();

  ws.addEventListener("message", (event: MessageEvent) => {
    const msg = JSON.parse(String(event.data)) as CdpMessage;
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        entry.resolve(msg.result);
      }
    } else if (msg.method) {
      const handlers = listeners.get(msg.method);
      if (handlers) {
        for (const h of handlers) {
          try {
            h(msg.params);
          } catch {
            // ignore handler errors
          }
        }
      }
    }
  });

  ws.addEventListener("error", () => {
    for (const [, { reject }] of pending) {
      reject(new Error("WebSocket error"));
    }
    pending.clear();
  });

  const ready = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("WebSocket connect error")));
  });

  return {
    async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
      await ready;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method: string, handler: (params: unknown) => void) {
      const arr = listeners.get(method) ?? [];
      arr.push(handler);
      listeners.set(method, arr);
    },
    off(method: string, handler: (params: unknown) => void) {
      const arr = listeners.get(method);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx !== -1) arr.splice(idx, 1);
      }
    },
    close() {
      ws.close();
    },
  };
}

interface PrefilterResult {
  cleanSkeleton: unknown[];
  viewport: { x: number; y: number; width: number; height: number } | null;
  deletedIds: string[];
}

/** Walk the skeleton array, extract pseudo-elements (cameraUpdate, delete,
 *  restoreCheckpoint), build a filtered skeleton ready for hydration. */
function prefilterSkeleton(skeleton: unknown[]): PrefilterResult {
  let viewport: { x: number; y: number; width: number; height: number } | null = null;
  const deletedSet = new Set<string>();

  for (const el of skeleton) {
    if (
      typeof el !== "object" ||
      el === null ||
      !("type" in el) ||
      typeof (el as Record<string, unknown>).type !== "string"
    ) {
      continue;
    }

    const typedEl = el as Record<string, unknown>;
    const type = typedEl.type as string;

    if (type === "cameraUpdate") {
      if (typeof typedEl.x === "number" && typeof typedEl.y === "number") {
        viewport = {
          x: typedEl.x,
          y: typedEl.y,
          width: typeof typedEl.width === "number" ? typedEl.width : 0,
          height: typeof typedEl.height === "number" ? typedEl.height : 0,
        };
      }
      continue;
    }

    if (type === "delete") {
      const ids = typedEl.ids as string | string[] | undefined;
      if (typeof ids === "string") {
        for (const id of ids.split(",")) {
          if (id.trim()) deletedSet.add(id.trim());
        }
      } else if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === "string") deletedSet.add(id);
        }
      }
      continue;
    }

    if (type === "restoreCheckpoint") {
      continue;
    }
  }

  const deletedIds = [...deletedSet];

  const cleanSkeleton = skeleton.filter((el) => {
    if (
      typeof el === "object" &&
      el !== null &&
      "type" in el &&
      typeof (el as Record<string, unknown>).type === "string"
    ) {
      const type = (el as Record<string, unknown>).type as string;
      if (type === "cameraUpdate" || type === "delete" || type === "restoreCheckpoint") {
        return false;
      }
    }

    const typedEl = el as Record<string, unknown>;
    const id = "id" in typedEl ? String(typedEl.id) : undefined;
    if (id && deletedSet.has(id)) return false;

    const containerId = "containerId" in typedEl ? String(typedEl.containerId) : undefined;
    if (containerId && deletedSet.has(containerId)) return false;

    return true;
  });

  return { cleanSkeleton, viewport, deletedIds };
}

/** Pick a free localhost port by spawning Chrome with port=0 and reading stderr. */
async function spawnChromeWithFreePort(
  chrome: string,
  userDataDir: string,
): Promise<{ proc: ReturnType<typeof Bun.spawn>; wsUrl: string }> {
  const proc = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-features=IsolateOrigins,site-per-process",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );

  const reader = proc.stderr!.getReader();
  let wsUrl = "";
  const decoder = new TextDecoder();
  const timeout = setTimeout(() => {
    reader.releaseLock();
    proc.kill();
    throw new Error("Timed out waiting for Chrome DevTools port line on stderr");
  }, 10_000);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      const match = text.match(
        /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/,
      );
      if (match) {
        wsUrl = match[1];
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }

  if (!wsUrl) {
    proc.kill();
    throw new Error("Chrome did not write DevTools WebSocket URL to stderr");
  }

  return { proc, wsUrl };
}

const HYDRATE_TIMEOUT_MS = 30_000;
const READY_POLL_TIMEOUT_MS = 5_000;
const READY_POLL_INTERVAL_MS = 100;

export async function hydrateExcalidrawSkeleton(input: HydrateInput): Promise<HydrateResult> {
  const startMs = performance.now();
  const { skeleton } = input;

  logger.info(
    { event: "excalidraw.hydrate.start", skeletonCount: skeleton.length },
    "excalidraw hydrate start",
  );

  const chrome = await findChrome();
  if (!chrome) {
    throw new Error(
      "No Chrome/Chromium binary found. Install Google Chrome or Playwright chromium.",
    );
  }

  // Pre-pass: strip pseudo-elements and deleted entries
  const { cleanSkeleton, viewport, deletedIds } = prefilterSkeleton(skeleton);

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userDataDir = join(tmpdir(), `sideclaw-excalidraw-hydrate-${stamp}`);
  await mkdir(userDataDir, { recursive: true });

  let proc: ReturnType<typeof Bun.spawn> | undefined;
  const cleanup = async () => {
    proc?.kill();
    await rm(userDataDir, { recursive: true, force: true });
  };

  try {
    const { proc: p, wsUrl } = await spawnChromeWithFreePort(chrome, userDataDir);
    proc = p;

    // Open a browser-level CDP connection to create a target page.
    const browserCdp = createCdpClient(wsUrl);
    let pageCdp: CdpClient | undefined;

    try {
      const targetRes = (await browserCdp.send("Target.createTarget", {
        url: "about:blank",
      })) as { targetId: string };
      const pageTargetId = targetRes.targetId;

      // Connect directly to the page target via its own WS endpoint.
      const pageWsUrl = wsUrl.replace(/\/devtools\/browser\/.+$/, `/devtools/page/${pageTargetId}`);
      pageCdp = createCdpClient(pageWsUrl);

      await pageCdp.send("Page.enable");

      // Navigate to the bundled HTML page and wait for load.
      const navigatePromise = pageCdp.send("Page.navigate", {
        url: BUNDLED_HTML_DATA_URL,
      });

      const loadFired = new Promise<void>((resolve, reject) => {
        const onLoad = () => {
          clearTimeout(timeout);
          pageCdp!.off("Page.loadEventFired", onLoad);
          resolve();
        };
        pageCdp!.on("Page.loadEventFired", onLoad);
        const timeout = setTimeout(() => {
          pageCdp!.off("Page.loadEventFired", onLoad);
          reject(new Error("Timeout waiting for Page.loadEventFired"));
        }, HYDRATE_TIMEOUT_MS);
      });

      await navigatePromise;
      await loadFired;

      // Poll for window.__ready
      const readyStart = performance.now();
      let ready = false;
      while (performance.now() - readyStart < READY_POLL_TIMEOUT_MS) {
        const evalRes = (await pageCdp.send("Runtime.evaluate", {
          expression: "window.__ready === true",
          returnByValue: true,
        })) as { result?: { value?: boolean } };
        if (evalRes.result?.value === true) {
          ready = true;
          break;
        }
        await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
      }

      if (!ready) {
        throw new Error("Excalidraw ESM bundle did not become ready within timeout");
      }

      // Run hydration
      const skeletonJson = JSON.stringify(cleanSkeleton);
      const hydrateRes = (await pageCdp.send("Runtime.evaluate", {
        expression: `window.__hydrate(JSON.parse(${JSON.stringify(skeletonJson)}))`,
        awaitPromise: true,
        returnByValue: true,
      })) as { result?: { value?: Record<string, unknown> } };

      const value = hydrateRes.result?.value;
      if (!value || typeof value !== "object") {
        throw new Error("Hydration returned no value from Chrome runtime");
      }

      const raw = value as {
        type?: string;
        version?: number;
        source?: string;
        elements?: unknown[];
        appState?: Record<string, unknown>;
        files?: Record<string, unknown>;
      };

      if (raw.type !== "excalidraw" || raw.version !== 2) {
        throw new Error(`Unexpected hydration output: type=${raw.type} version=${raw.version}`);
      }

      const file = {
        type: "excalidraw" as const,
        version: 2 as const,
        source: "https://sideclaw.local",
        elements: raw.elements ?? [],
        appState: raw.appState ?? {},
        files: raw.files ?? {},
      };

      const elementCount = file.elements.length;
      const durationMs = Math.round(performance.now() - startMs);

      logger.info(
        {
          event: "excalidraw.hydrate.end",
          elementCount,
          durationMs,
        },
        "excalidraw hydrate end",
      );

      return {
        file,
        viewport,
        deletedIds,
        elementCount,
      };
    } finally {
      pageCdp?.close();
      browserCdp.close();
    }
  } catch (err) {
    const durationMs = Math.round(performance.now() - startMs);
    logger.error(
      {
        event: "excalidraw.hydrate.error",
        durationMs,
        err,
      },
      "excalidraw hydrate error",
    );
    await cleanup();
    throw err;
  } finally {
    await cleanup();
  }
}

// Self-check: run with `bun server/lib/excalidraw-hydrate.ts`
if (import.meta.main) {
  const sample: unknown[] = [
    { type: "cameraUpdate", x: 0, y: 0, width: 800, height: 600 },
    {
      type: "rectangle",
      id: "r1",
      x: 100,
      y: 100,
      width: 200,
      height: 80,
      label: { text: "Hello", fontSize: 18 },
    },
    { type: "ellipse", id: "e1", x: 400, y: 100, width: 120, height: 120 },
    { type: "diamond", id: "d1", x: 600, y: 100, width: 120, height: 80 },
    {
      type: "arrow",
      id: "a1",
      x: 0,
      y: 0,
      width: 1,
      height: 0,
      points: [
        [0, 0],
        [1, 0],
      ],
      endArrowhead: "arrow",
      start: { id: "r1" },
      end: { id: "e1" },
    },
    { type: "text", id: "t1", x: 100, y: 220, text: "annotation", fontSize: 14 },
  ];

  hydrateExcalidrawSkeleton({ skeleton: sample })
    .then((result) => {
      console.log("Type:", result.file.type);
      console.log("Version:", result.file.version);
      console.log("Source:", result.file.source);
      console.log("Elements:", result.elementCount);
      console.log("Viewport:", result.viewport);
      console.log("Deleted IDs:", result.deletedIds.length);
      if (result.elementCount < 5) {
        throw new Error(`Expected at least 5 elements, got ${result.elementCount}`);
      }
      if (!result.viewport || result.viewport.width !== 800) {
        throw new Error("Expected viewport { width: 800, ... } from cameraUpdate");
      }
      console.log("Self-check passed.");
    })
    .catch((err) => {
      console.error("Self-check failed:", err);
      process.exit(1);
    });
}
