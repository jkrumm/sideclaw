import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  InputGroup,
  OverlayToaster,
  Popover,
  Spinner,
  Tooltip,
} from "@blueprintjs/core";
import { api } from "../lib/api";
import { useTheme } from "../main";
import { DiagramEditor } from "./DiagramEditor";
import type { DiagramEditorHandle, SaveStatus } from "./DiagramEditor";

interface DiagramMeta {
  name: string;
  hasSvg: boolean;
  modifiedAt: number;
}

interface Props {
  repoPath: string;
}

const EMPTY_EXCALIDRAW = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "sideclaw",
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
});

// Module-level toaster singleton — created once on first use
let _toaster: OverlayToaster | null = null;
function showToast(message: string, intent: "success" | "warning" = "success") {
  const icon = intent === "warning" ? "warning-sign" : "tick-circle";
  const show = (t: OverlayToaster) =>
    t.show({ message, intent, icon, timeout: intent === "warning" ? 4000 : 2500 });

  if (_toaster) {
    show(_toaster);
  } else {
    void OverlayToaster.createAsync({ position: "top-right" }).then((t) => {
      _toaster = t;
      show(t);
    });
  }
}

type DocWithWebkit = Document & {
  webkitFullscreenElement?: Element;
  webkitExitFullscreen?: () => Promise<void>;
};
type ElWithWebkit = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void>;
};

const fsElement = () =>
  document.fullscreenElement ?? (document as DocWithWebkit).webkitFullscreenElement;

const fsEnter = (el: HTMLElement) => {
  if (el.requestFullscreen) return el.requestFullscreen();
  if ((el as ElWithWebkit).webkitRequestFullscreen) return (el as ElWithWebkit).webkitRequestFullscreen!();
  return Promise.reject(new Error("Fullscreen not supported"));
};

const fsExit = () => {
  if (document.exitFullscreen) return document.exitFullscreen();
  if ((document as DocWithWebkit).webkitExitFullscreen) return (document as DocWithWebkit).webkitExitFullscreen!();
  return Promise.resolve();
};

function relativeTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

export function DiagramPanel({ repoPath }: Props) {
  const { isDark } = useTheme();
  const panelRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<DiagramEditorHandle | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const hasRestoredRef = useRef(false);
  const deletedDiagramsRef = useRef<Set<string>>(new Set());
  const storagePrefix = `sideclaw:${repoPath}`;

  // Panel state
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(`${storagePrefix}:diagramsCollapsed`) === "true",
  );
  const [diagrams, setDiagrams] = useState<DiagramMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeDiagram, setActiveDiagram] = useState<string | null>(null);
  const [openDiagrams, setOpenDiagrams] = useState<string[]>([]);
  const [diagramContents, setDiagramContents] = useState<Record<string, string>>({});
  const [diagBrowserOpen, setDiagBrowserOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [svgVersions, setSvgVersions] = useState<Record<string, number>>({});

  // Server mtime per diagram — used by syncDiagram to skip unnecessary remounts
  const [diagramVersions, setDiagramVersions] = useState<Record<string, number>>({});
  // Incremented to force DiagramEditor remount when content changes externally
  const [diagramReloadCounts, setDiagramReloadCounts] = useState<Record<string, number>>({});
  // When this tab last saved (for status indicator)
  const [lastSavedAt, setLastSavedAt] = useState<Record<string, number>>({});
  // Ticks every second so relative timestamps stay current
  const [now, setNow] = useState(Date.now);

  // ── Pessimistic edit lock ────────────────────────────────────────────────────
  // null = view mode, string = editing (this is the lock token for heartbeat/release)
  const [lockToken, setLockToken] = useState<string | null>(null);
  const [isAcquiringLock, setIsAcquiringLock] = useState(false);
  // Set when another session holds the lock — ms elapsed since they acquired it
  const [lockDeniedMs, setLockDeniedMs] = useState<number | null>(null);

  // SSE connection state for the diagram event stream
  const [sseConnected, setSseConnected] = useState(false);

  // Stable refs — SSE callbacks and effects read these without stale closures
  const lockTokenRef = useRef<string | null>(null);
  const activeDiagramRef = useRef<string | null>(null);
  const openDiagramsRef = useRef<string[]>([]);
  const diagramVersionsRef = useRef<Record<string, number>>({});
  lockTokenRef.current = lockToken;
  activeDiagramRef.current = activeDiagram;
  openDiagramsRef.current = openDiagrams;
  diagramVersionsRef.current = diagramVersions;

  // Fullscreen state
  const [appFullscreen, setAppFullscreen] = useState(false);
  const [browserFullscreen, setBrowserFullscreen] = useState(false);

  // New diagram dialog state
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newNameError, setNewNameError] = useState("");

  // Sub-header inline rename/delete state
  const [subRenameOpen, setSubRenameOpen] = useState(false);
  const [subRenameValue, setSubRenameValue] = useState("");
  const [subDeleteOpen, setSubDeleteOpen] = useState(false);

  const isFullscreen = appFullscreen || browserFullscreen;

  // ── Fetch diagrams ──────────────────────────────────────────────────────────

  const fetchDiagrams = useCallback(async () => {
    setLoading(true);
    const res = await api.api.diagrams
      .get({ query: { path: repoPath } })
      .catch(() => null);
    setLoading(false);
    if (res?.data?.ok) setDiagrams(res.data.data as DiagramMeta[]);
  }, [repoPath]);

  useEffect(() => {
    fetchDiagrams();
    // Preload Excalidraw in background — 582 kB chunk parses while user reads
    // the panel, so it's ready by the time they click a diagram.
    void import("./ExcalidrawLazy");
  }, [fetchDiagrams]);

  // Persist open tabs + active diagram
  useEffect(() => {
    if (openDiagrams.length > 0) {
      localStorage.setItem(`${storagePrefix}:openDiagrams`, JSON.stringify(openDiagrams));
    }
  }, [openDiagrams, storagePrefix]);

  useEffect(() => {
    if (activeDiagram !== null) {
      localStorage.setItem(`${storagePrefix}:activeDiagram`, activeDiagram);
    }
  }, [activeDiagram, storagePrefix]);

  // 1-second tick for relative timestamps
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // ── Open diagram ────────────────────────────────────────────────────────────

  const openDiagram = useCallback(
    async (name: string) => {
      if (name === activeDiagram) return;
      if (openDiagrams.includes(name)) {
        setActiveDiagram(name);
        setDiagBrowserOpen(false);
        return;
      }
      const res = await api.api.diagrams.file
        .get({ query: { path: repoPath, name } })
        .catch(() => null);
      if (res?.data?.ok) {
        const loaded = res.data as { ok: true; data: string; modifiedAt: number };
        setDiagramContents((prev) => ({ ...prev, [name]: loaded.data }));
        setDiagramVersions((prev) => ({ ...prev, [name]: loaded.modifiedAt ?? 0 }));
        setOpenDiagrams((prev) => [...prev, name]);
        setActiveDiagram(name);
        setSaveStatus("idle");
        setDiagBrowserOpen(false);
      }
    },
    [activeDiagram, openDiagrams, repoPath],
  );

  const closeTab = (name: string) => {
    const newOpen = openDiagrams.filter((n) => n !== name);
    setOpenDiagrams(newOpen);
    setDiagramContents((prev) => { const { [name]: _, ...rest } = prev; return rest; });
    if (activeDiagram === name) {
      const idx = openDiagrams.indexOf(name);
      setActiveDiagram(newOpen[idx] ?? newOpen[idx - 1] ?? null);
    }
  };

  // Restore open tabs + active diagram after initial load
  useEffect(() => {
    if (hasRestoredRef.current || diagrams.length === 0) return;
    hasRestoredRef.current = true;

    const savedActive = localStorage.getItem(`${storagePrefix}:activeDiagram`);
    const savedOpenRaw = localStorage.getItem(`${storagePrefix}:openDiagrams`);
    const savedOpen: string[] = savedOpenRaw ? (JSON.parse(savedOpenRaw) as string[]) : [];

    const validOpen = savedOpen.filter((n) => diagrams.some((d) => d.name === n));
    const validActive = savedActive && diagrams.some((d) => d.name === savedActive) ? savedActive : null;

    const toOpen = validActive && !validOpen.includes(validActive)
      ? [...validOpen, validActive]
      : validOpen;

    if (toOpen.length === 0) return;

    void Promise.all(
      toOpen.map((name) =>
        api.api.diagrams.file
          .get({ query: { path: repoPath, name } })
          .then((res) =>
            res?.data?.ok
              ? { name, content: (res.data as { data: string }).data, modifiedAt: (res.data as { modifiedAt: number }).modifiedAt ?? 0 }
              : null,
          )
          .catch(() => null),
      ),
    ).then((results) => {
      const loaded = results.filter(
        (r): r is { name: string; content: string; modifiedAt: number } => r !== null,
      );
      if (loaded.length === 0) return;
      const contents: Record<string, string> = {};
      const versions: Record<string, number> = {};
      const openNames: string[] = [];
      for (const { name, content, modifiedAt } of loaded) {
        contents[name] = content;
        versions[name] = modifiedAt;
        openNames.push(name);
      }
      setDiagramContents(contents);
      setDiagramVersions(versions);
      setOpenDiagrams(openNames);
      setActiveDiagram(validActive && openNames.includes(validActive) ? validActive : openNames[0]);
      setSaveStatus("idle");
    });
  }, [diagrams, storagePrefix, repoPath]);

  // ── Lock management ─────────────────────────────────────────────────────────

  // Release a lock, fire-and-forget. Safe to call even if already released.
  const doReleaseLock = useCallback((name: string, token: string) => {
    const url = `/api/diagrams/lock/release?path=${encodeURIComponent(repoPath)}&name=${encodeURIComponent(name)}&token=${encodeURIComponent(token)}`;
    void fetch(url, { method: "POST" }).catch(() => {});
  }, [repoPath]);

  // Acquire lock and enter edit mode. Fetches latest content before opening editor.
  const handleEditClick = useCallback(async () => {
    const name = activeDiagramRef.current;
    if (!name || isAcquiringLock || lockTokenRef.current) return;

    setIsAcquiringLock(true);
    setLockDeniedMs(null);

    try {
      const res = await fetch(
        `/api/diagrams/lock?path=${encodeURIComponent(repoPath)}&name=${encodeURIComponent(name)}`,
        { method: "POST" },
      );

      if (res.ok) {
        const { token } = await res.json() as { token: string };

        // Fetch latest from server before opening editor — ensures we start from
        // the current state even if another instance saved while we were viewing.
        const fresh = await api.api.diagrams.file
          .get({ query: { path: repoPath, name } })
          .catch(() => null);
        if (fresh?.data?.ok) {
          const data = fresh.data as { ok: true; data: string; modifiedAt: number };
          if ((diagramVersionsRef.current[name] ?? 0) < data.modifiedAt) {
            setDiagramContents((prev) => ({ ...prev, [name]: data.data }));
            setDiagramVersions((prev) => ({ ...prev, [name]: data.modifiedAt }));
            setDiagramReloadCounts((prev) => ({ ...prev, [name]: (prev[name] ?? 0) + 1 }));
          }
        }

        setLockToken(token);
        setSaveStatus("idle");
      } else if (res.status === 423) {
        const body = await res.json() as { lockedAgoMs: number };
        setLockDeniedMs(body.lockedAgoMs);
        const ago = Math.round(body.lockedAgoMs / 1000);
        showToast(`Another instance is editing this diagram (locked ${ago}s ago)`, "warning");
      } else {
        showToast("Failed to acquire edit lock", "warning");
      }
    } catch {
      showToast("Failed to acquire edit lock", "warning");
    } finally {
      setIsAcquiringLock(false);
    }
  }, [repoPath, isAcquiringLock]);

  // Release lock and return to view mode (manual).
  const handleLockClick = useCallback(() => {
    const name = activeDiagramRef.current;
    const token = lockTokenRef.current;
    if (!name || !token) return;
    // Flush any pending save first
    editorRef.current?.save();
    setLockToken(null);
    setLockDeniedMs(null);
    doReleaseLock(name, token);
  }, [doReleaseLock]);

  // Release lock when switching diagram tabs — each diagram has its own lock.
  useEffect(() => {
    return () => {
      const token = lockTokenRef.current;
      const name = activeDiagramRef.current;
      if (token && name) {
        setLockToken(null);
        doReleaseLock(name, token);
      }
    };
    // Run only when activeDiagram changes (not on every render)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDiagram]);

  // Heartbeat — keeps the server-side lock alive every 15s.
  // On failure (401 = expired, or 3 consecutive network errors): drop to view mode.
  useEffect(() => {
    if (!lockToken || !activeDiagram) return;

    let consecutiveErrors = 0;

    const doHeartbeat = async () => {
      const token = lockTokenRef.current;
      const name = activeDiagramRef.current;
      if (!token || !name) return;

      const res = await fetch(
        `/api/diagrams/lock/heartbeat?path=${encodeURIComponent(repoPath)}&name=${encodeURIComponent(name)}&token=${encodeURIComponent(token)}`,
        { method: "POST" },
      ).catch(() => null);

      if (res?.ok) {
        consecutiveErrors = 0;
        return;
      }

      if (res?.status === 401) {
        // Lock expired on server (e.g. server restarted between heartbeats).
        // The SSE serverStart check will trigger a page reload if the server
        // actually restarted, so this is a rare genuine expiry case.
        setLockToken(null);
        showToast("Edit session expired — returned to view mode", "warning");
        return;
      }

      // Network error — count failures before giving up
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        setLockToken(null);
        showToast("Connection lost — returned to view mode", "warning");
        consecutiveErrors = 0;
      }
    };

    const id = setInterval(() => { void doHeartbeat(); }, 15_000);
    return () => clearInterval(id);
  }, [lockToken, activeDiagram, repoPath]);

  // Release lock via sendBeacon on page unload — fires reliably before tab closes.
  // TTL (45s) is the safety net for cases where beforeunload doesn't fire.
  useEffect(() => {
    const onUnload = () => {
      const token = lockTokenRef.current;
      const name = activeDiagramRef.current;
      if (token && name) {
        navigator.sendBeacon(
          `/api/diagrams/lock/release?path=${encodeURIComponent(repoPath)}&name=${encodeURIComponent(name)}&token=${encodeURIComponent(token)}`,
        );
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [repoPath]);

  // ── Save handler ────────────────────────────────────────────────────────────

  const handleSave = useCallback(
    async (name: string, excalidraw: string, svg: string) => {
      if (deletedDiagramsRef.current.has(name)) return;

      const token = lockTokenRef.current;
      if (!token) {
        // Should never happen — DiagramEditor only fires onChange when unlocked.
        // Guard here so we never accidentally write without a lock.
        throw new Error("Cannot save without an edit lock");
      }

      setDiagramContents((prev) => ({ ...prev, [name]: excalidraw }));

      const res = await fetch(
        `/api/diagrams/file?path=${encodeURIComponent(repoPath)}&name=${encodeURIComponent(name)}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-lock-token": token,
          },
          body: JSON.stringify({ excalidraw, svg }),
        },
      ).catch(() => null);

      if (!res) throw new Error("Save failed — network error");

      if (res.status === 403) {
        // Lock was lost mid-edit (server restart during 45s TTL window, very rare).
        // SSE serverStart detection will trigger a page reload if server restarted.
        // Otherwise, drop back to view mode gracefully.
        setLockToken(null);
        throw new Error("Edit lock expired — please re-enter edit mode");
      }

      if (!res.ok) throw new Error(`Save failed — HTTP ${res.status}`);

      const body = await res.json() as { ok: boolean; modifiedAt?: number };
      if (body.modifiedAt) {
        setDiagramVersions((prev) => ({ ...prev, [name]: body.modifiedAt! }));
      }
      setLastSavedAt((prev) => ({ ...prev, [name]: Date.now() }));
      setSvgVersions((prev) => ({ ...prev, [name]: Date.now() }));
      setDiagrams((prev) =>
        prev.map((d) => (d.name === name ? { ...d, hasSvg: true } : d)),
      );
    },
    [repoPath],
  );

  // ── Sync diagram (viewer refresh) ───────────────────────────────────────────
  // Fetches latest from server and remounts the editor if content is newer.
  // Only called on viewer tabs — editors never call this (they hold the lock).

  const syncDiagram = useCallback((name: string) => {
    void api.api.diagrams.file
      .get({ query: { path: repoPath, name } })
      .then((res) => {
        if (!res?.data?.ok) return;
        const fresh = res.data as { ok: true; data: string; modifiedAt: number };
        // Skip if we already have this version or newer
        if ((diagramVersionsRef.current[name] ?? 0) >= fresh.modifiedAt) return;
        setDiagramContents((prev) => ({ ...prev, [name]: fresh.data }));
        setDiagramVersions((prev) => ({ ...prev, [name]: fresh.modifiedAt }));
        setDiagramReloadCounts((prev) => ({ ...prev, [name]: (prev[name] ?? 0) + 1 }));
        setLastSavedAt((prev) => ({ ...prev, [name]: Date.now() }));
      })
      .catch(() => {});
  }, [repoPath]);

  // ── SSE for real-time diagram sync ──────────────────────────────────────────
  // Lock is the single source of truth for "who is editing":
  //   lock held (lockToken !== null) → I'm the writer, ignore all SSE change events
  //   no lock                        → I'm a viewer, sync on any change event

  useEffect(() => {
    let closed = false;
    let es: EventSource | null = null;
    let serverStart: number | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    const resetWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (!closed) {
          es?.close();
          setSseConnected(false);
          setTimeout(connect, 100);
        }
      }, 35_000);
    };

    const connect = () => {
      if (closed) return;
      es = new EventSource(`/api/events?path=${encodeURIComponent(repoPath)}`);

      es.addEventListener("connected", (e: MessageEvent) => {
        const data = JSON.parse(e.data as string) as { serverStart?: number };
        if (data.serverStart) {
          if (serverStart !== null && serverStart !== data.serverStart) {
            window.location.reload();
            return;
          }
          serverStart = data.serverStart;
        }
        setSseConnected(true);
        // On reconnect, sync all open diagrams that this tab is viewing (not editing)
        for (const name of openDiagramsRef.current) {
          if (lockTokenRef.current && name === activeDiagramRef.current) continue;
          syncDiagram(name);
        }
        resetWatchdog();
      });

      es.addEventListener("ping", () => {
        setSseConnected(true);
        resetWatchdog();
      });

      es.addEventListener("change", (e: MessageEvent) => {
        resetWatchdog();
        const payload = JSON.parse(e.data as string) as { file: string; name?: string; modifiedAt?: number };
        if (payload.file !== "diagram" || !payload.name || !payload.modifiedAt) return;
        const { name } = payload as { name: string };

        // If we hold the lock, we caused this event — skip
        if (lockTokenRef.current) return;

        // Not open — nothing to update
        if (!openDiagramsRef.current.includes(name)) return;

        syncDiagram(name);
      });

      es.onerror = () => {
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        es?.close();
        setSseConnected(false);
        if (!closed) setTimeout(connect, 5_000);
      };
    };

    connect();
    return () => {
      closed = true;
      if (watchdog) clearTimeout(watchdog);
      es?.close();
    };
  }, [repoPath, syncDiagram]);

  // ── New diagram ─────────────────────────────────────────────────────────────

  const validateName = (name: string, existingNames: string[]): string => {
    const trimmed = name.trim();
    if (!trimmed) return "Name is required";
    if (!/^[a-zA-Z0-9 \-_]+$/.test(trimmed))
      return "Only letters, numbers, spaces, hyphens and underscores allowed";
    if (existingNames.includes(trimmed))
      return "A diagram with this name already exists";
    return "";
  };

  const handleCreateDiagram = async () => {
    const name = newName.trim();
    const error = validateName(name, diagrams.map((d) => d.name));
    if (error) { setNewNameError(error); return; }

    await api.api.diagrams.file.put(
      { excalidraw: EMPTY_EXCALIDRAW, svg: "" },
      { query: { path: repoPath, name } },
    );

    const newMeta: DiagramMeta = { name, hasSvg: false, modifiedAt: Date.now() };
    setDiagrams((prev) => [newMeta, ...prev]);
    setNewDialogOpen(false);
    setNewName("");
    setNewNameError("");
    await openDiagram(name);
    // Auto-acquire lock for freshly created diagrams — user intent is to edit
    await handleEditClick();
  };

  // ── Rename ──────────────────────────────────────────────────────────────────

  const handleRename = useCallback(
    async (name: string, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed || trimmed === name) return;
      await api.api.diagrams.rename.post(
        { name, newName: trimmed },
        { query: { path: repoPath } },
      );
      setDiagrams((prev) => prev.map((d) => (d.name === name ? { ...d, name: trimmed } : d)));
      setOpenDiagrams((prev) => prev.map((n) => (n === name ? trimmed : n)));
      setDiagramContents((prev) => {
        const { [name]: content, ...rest } = prev;
        return content !== undefined ? { ...rest, [trimmed]: content } : rest;
      });
      if (activeDiagram === name) setActiveDiagram(trimmed);
    },
    [repoPath, activeDiagram],
  );

  // ── Delete ──────────────────────────────────────────────────────────────────

  const handleDelete = useCallback(
    async (name: string) => {
      deletedDiagramsRef.current.add(name);
      await api.api.diagrams.file.delete({ query: { path: repoPath, name } });
      setDiagrams((prev) => prev.filter((d) => d.name !== name));
      setDiagramContents((prev) => { const { [name]: _, ...rest } = prev; return rest; });
      setOpenDiagrams((prev) => {
        const newOpen = prev.filter((n) => n !== name);
        if (activeDiagram === name) {
          const idx = prev.indexOf(name);
          setActiveDiagram(newOpen[idx] ?? newOpen[idx - 1] ?? null);
        }
        return newOpen;
      });
    },
    [repoPath, activeDiagram],
  );

  // ── Copy SVG path ───────────────────────────────────────────────────────────

  const handleCopySvgPath = (name: string) => {
    const path = `docs/diagrams/${name}.svg`;
    const copyFallback = () => {
      const ta = document.createElement("textarea");
      ta.value = path;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        const ok = document.execCommand("copy");
        showToast(ok ? `Copied: ${path}` : "Copy failed");
      } catch {
        showToast("Copy failed");
      }
      document.body.removeChild(ta);
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(path)
        .then(() => showToast(`Copied: ${path}`))
        .catch(copyFallback);
    } else {
      copyFallback();
    }
  };

  // ── Collapse ────────────────────────────────────────────────────────────────

  const toggleCollapse = () => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(`${storagePrefix}:diagramsCollapsed`, String(next));
      return next;
    });
  };

  // ── App fullscreen (focus mode) ─────────────────────────────────────────────

  const toggleAppFullscreen = () => {
    if (fsElement()) void fsExit();
    setAppFullscreen((prev) => !prev);
  };

  // ── Browser fullscreen ──────────────────────────────────────────────────────

  const tryKiosk = useCallback(() => {
    const url = encodeURIComponent(window.location.href);
    void fetch(`/api/open-kiosk?url=${url}`)
      .then((r) => { if (!r.ok) setAppFullscreen(true); })
      .catch(() => setAppFullscreen(true));
  }, []);

  const toggleBrowserFullscreen = useCallback(() => {
    if (appFullscreen) { setAppFullscreen(false); return; }
    if (fsElement()) { void fsExit(); return; }
    const fsEnabled =
      document.fullscreenEnabled ??
      (document as DocWithWebkit).webkitFullscreenEnabled ??
      false;
    if (!fsEnabled) { tryKiosk(); return; }
    void fsEnter(document.documentElement).catch(tryKiosk);
  }, [appFullscreen, tryKiosk]);

  useEffect(() => {
    const handler = () => {
      const isFs = !!fsElement();
      setBrowserFullscreen(isFs);
      if (!isFs) setAppFullscreen(false);
    };
    document.addEventListener("fullscreenchange", handler);
    document.addEventListener("webkitfullscreenchange", handler);
    return () => {
      document.removeEventListener("fullscreenchange", handler);
      document.removeEventListener("webkitfullscreenchange", handler);
    };
  }, []);

  // ── Status indicator ─────────────────────────────────────────────────────────

  const activeLastSaved = activeDiagram ? (lastSavedAt[activeDiagram] ?? null) : null;
  const activeServerMtime = activeDiagram ? (diagramVersions[activeDiagram] ?? null) : null;
  const savedSecondsAgo = activeLastSaved !== null ? now - activeLastSaved : null;
  const savedRecently = savedSecondsAgo !== null && savedSecondsAgo < 10_000 && saveStatus !== "dirty";

  const dotColor = saveStatus === "saving"
    ? "#4C90F0"
    : savedRecently
      ? "#72CA9B"
      : saveStatus === "dirty"
        ? "#F0A53D"
        : "#8F99A8"; // muted when idle with no recent save

  const dotAnimation = saveStatus === "saving"
    ? "dot-pulse 0.7s ease-in-out infinite"
    : undefined;

  // Tooltip: structured multi-line content
  const isEditing = lockToken !== null;
  const tooltipLines: string[] = [];
  if (isEditing) {
    tooltipLines.push("Editing");
    if (saveStatus === "saving") tooltipLines.push("Saving…");
    else if (saveStatus === "dirty") tooltipLines.push("Unsaved changes");
    else if (activeLastSaved !== null) tooltipLines.push(`Saved ${relativeTime(now - activeLastSaved)}`);
    else tooltipLines.push("Not yet saved");
  } else if (lockDeniedMs !== null) {
    tooltipLines.push(`Locked by another session (${Math.round(lockDeniedMs / 1000)}s ago)`);
    tooltipLines.push("Click lock icon to retry");
  } else {
    tooltipLines.push("View mode — click lock to edit");
    if (activeServerMtime !== null) tooltipLines.push(`Server updated ${relativeTime(now - activeServerMtime)}`);
  }
  if (!sseConnected) tooltipLines.push("⚠ Reconnecting…");

  const tooltipContent = (
    <div style={{ fontSize: 12, lineHeight: 1.6 }}>
      {tooltipLines.map((line, i) => <div key={i}>{line}</div>)}
    </div>
  );

  // ── Panel styles ─────────────────────────────────────────────────────────────

  const appFullscreenStyle: React.CSSProperties = appFullscreen
    ? {
        position: "fixed",
        top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 20,
        overflowY: "auto",
        padding: 24,
        background: isDark
          ? "var(--bp-palette-dark-gray-1)"
          : "var(--bp-palette-light-gray-5)",
        display: "flex",
        flexDirection: "column",
      }
    : {};

  const browserFullscreenStyle: React.CSSProperties = browserFullscreen
    ? {
        height: "100vh",
        overflowY: "auto",
        padding: 24,
        background: isDark
          ? "var(--bp-palette-dark-gray-1)"
          : "var(--bp-palette-light-gray-5)",
        display: "flex",
        flexDirection: "column",
      }
    : {};

  const panelStyle: React.CSSProperties = {
    ...appFullscreenStyle,
    ...browserFullscreenStyle,
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div ref={panelRef} style={panelStyle}>
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: collapsed ? 0 : 12,
          flexShrink: 0,
        }}
      >
        <p className="section-label" style={{ flexShrink: 0 }}>Diagrams</p>
        <Button
          variant="minimal"
          small
          icon={collapsed ? "chevron-right" : "chevron-down"}
          onClick={toggleCollapse}
          style={{ flexShrink: 0 }}
        />

        {!collapsed && (
          <>
            {/* Lock + save status — only when a diagram is active */}
            {activeDiagram !== null && (
              <Tooltip content={tooltipContent} placement="bottom">
                <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                  {/* Lock icon button */}
                  {isAcquiringLock ? (
                    <Spinner size={12} />
                  ) : (
                    <Button
                      variant="minimal"
                      small
                      icon={isEditing ? "unlock" : "lock"}
                      onClick={isEditing ? handleLockClick : () => { void handleEditClick(); }}
                      style={{
                        minWidth: 0,
                        minHeight: 0,
                        padding: "2px 4px",
                        color: isEditing
                          ? "var(--bp-intent-primary-default-color)"
                          : lockDeniedMs !== null
                            ? "var(--bp-intent-danger-default-color)"
                            : "var(--bp-typography-color-muted)",
                      }}
                    />
                  )}
                  {/* Save status dot */}
                  <div
                    role="status"
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: dotColor,
                      flexShrink: 0,
                      transition: "background 0.5s",
                      animation: dotAnimation,
                    }}
                  />
                  {/* SSE disconnected indicator */}
                  {!sseConnected && (
                    <div
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "var(--bp-intent-danger-default-color)",
                        flexShrink: 0,
                      }}
                    />
                  )}
                </div>
              </Tooltip>
            )}

            <div style={{ flex: 1 }} />

            {/* Per-diagram actions — save, copy, rename, delete */}
            {activeDiagram !== null && (
              <>
                <Tooltip content="Save (⌘S)" placement="bottom">
                  <Button
                    small
                    variant="minimal"
                    icon="floppy-disk"
                    onClick={() => editorRef.current?.save()}
                    style={{ flexShrink: 0 }}
                  />
                </Tooltip>
                <Tooltip content="Copy SVG path" placement="bottom">
                  <Button
                    small
                    variant="minimal"
                    icon="clipboard"
                    onClick={() => handleCopySvgPath(activeDiagram)}
                    style={{ flexShrink: 0 }}
                  />
                </Tooltip>
                <Popover
                  isOpen={subRenameOpen}
                  onInteraction={(next) => { if (!next) setSubRenameOpen(false); }}
                  placement="bottom-end"
                  content={
                    <div style={{ padding: 12, width: 220 }}>
                      <InputGroup
                        small
                        autoFocus
                        value={subRenameValue}
                        onChange={(e) => setSubRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { void handleRename(activeDiagram, subRenameValue); setSubRenameOpen(false); }
                          if (e.key === "Escape") setSubRenameOpen(false);
                        }}
                      />
                      <div style={{ marginTop: 8, display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        <Button small text="Cancel" onClick={() => setSubRenameOpen(false)} />
                        <Button small intent="primary" text="Rename" onClick={() => { void handleRename(activeDiagram, subRenameValue); setSubRenameOpen(false); }} />
                      </div>
                    </div>
                  }
                >
                  <Tooltip content="Rename" placement="bottom" disabled={subRenameOpen}>
                    <Button
                      small variant="minimal" icon="edit"
                      onClick={() => { setSubRenameValue(activeDiagram); setSubRenameOpen(true); }}
                      style={{ flexShrink: 0 }}
                    />
                  </Tooltip>
                </Popover>
                <Popover
                  isOpen={subDeleteOpen}
                  onInteraction={(next) => { if (!next) setSubDeleteOpen(false); }}
                  placement="bottom-end"
                  content={
                    <div style={{ padding: 12 }}>
                      <p style={{ margin: "0 0 8px", fontSize: 13 }}>Delete "{activeDiagram}"?</p>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        <Button small text="Cancel" onClick={() => setSubDeleteOpen(false)} />
                        <Button small text="Delete" onClick={() => { void handleDelete(activeDiagram); setSubDeleteOpen(false); }} />
                      </div>
                    </div>
                  }
                >
                  <Tooltip content="Delete" placement="bottom" disabled={subDeleteOpen}>
                    <Button
                      small variant="minimal" icon="trash"
                      onClick={() => setSubDeleteOpen(true)}
                      style={{ flexShrink: 0 }}
                    />
                  </Tooltip>
                </Popover>
              </>
            )}

            {activeDiagram !== null && (
              <div style={{ width: 1, height: 16, background: "var(--bp-surface-border-color-default)", marginInline: 2, flexShrink: 0 }} />
            )}

            {/* New diagram */}
            <Tooltip content="New diagram" placement="bottom">
              <Button
                small variant="minimal" icon="plus"
                onClick={() => { setNewName(""); setNewNameError(""); setNewDialogOpen(true); }}
                style={{ flexShrink: 0 }}
              />
            </Tooltip>

            {/* Diagram browser */}
            {activeDiagram !== null && (
              <Popover
                isOpen={diagBrowserOpen}
                onInteraction={(next) => setDiagBrowserOpen(next)}
                placement="bottom-end"
                content={
                  <div style={{ padding: 8, width: 380, maxHeight: 420, overflowY: "auto" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                      {diagrams.map((d) => (
                        <DiagramCard
                          key={d.name}
                          diagram={d}
                          repoPath={repoPath}
                          isActive={d.name === activeDiagram}
                          svgVersion={svgVersions[d.name] ?? d.modifiedAt}
                          onOpen={(name) => { void openDiagram(name); setDiagBrowserOpen(false); }}
                          onRename={(name, newName) => void handleRename(name, newName)}
                          onDelete={(name) => void handleDelete(name)}
                          onCopyPath={handleCopySvgPath}
                        />
                      ))}
                      <Card
                        onClick={() => { setNewName(""); setNewNameError(""); setNewDialogOpen(true); setDiagBrowserOpen(false); }}
                        style={{
                          padding: 8, display: "flex", flexDirection: "column",
                          alignItems: "center", justifyContent: "center", gap: 6,
                          cursor: "pointer", border: "1.5px dashed var(--bp-surface-border-color-default)",
                          boxShadow: "none", minHeight: 108, background: "transparent",
                        }}
                      >
                        <Icon icon="plus" size={20} color="var(--bp-typography-color-muted)" />
                        <span style={{ fontSize: 11, color: "var(--bp-typography-color-muted)" }}>New Diagram</span>
                      </Card>
                    </div>
                  </div>
                }
              >
                <Tooltip content="Switch diagram" placement="bottom" disabled={diagBrowserOpen}>
                  <Button variant="minimal" small icon="diagram-tree" style={{ flexShrink: 0 }} />
                </Tooltip>
              </Popover>
            )}

            {/* Focus mode */}
            <Tooltip
              content={appFullscreen ? "Exit focus mode" : "Focus mode — hide other panels"}
              placement="bottom"
            >
              <Button
                variant="minimal" small
                icon={appFullscreen ? "minimize" : "maximize"}
                onClick={toggleAppFullscreen}
                style={{ flexShrink: 0 }}
              />
            </Tooltip>

            {/* Browser fullscreen */}
            <Tooltip
              content={browserFullscreen || appFullscreen ? "Exit fullscreen" : "Fullscreen (Cmd+Q to exit kiosk)"}
              placement="bottom"
            >
              <Button
                variant="minimal" small icon="fullscreen"
                onClick={toggleBrowserFullscreen}
                style={{ flexShrink: 0 }}
              />
            </Tooltip>
          </>
        )}
      </div>

      {/* Body */}
      {!collapsed && (
        <div
          style={
            isFullscreen
              ? { flex: 1, display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }
              : { display: "flex", flexDirection: "column", gap: 12 }
          }
        >
          {/* Diagram grid — only when no diagram is open */}
          {activeDiagram === null && (
            loading && diagrams.length === 0 ? (
              <div style={{ display: "flex", justifyContent: "center", padding: 16 }}>
                <Spinner size={20} />
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                {diagrams.map((d) => (
                  <DiagramCard
                    key={d.name}
                    diagram={d}
                    repoPath={repoPath}
                    isActive={false}
                    svgVersion={svgVersions[d.name] ?? d.modifiedAt}
                    onOpen={openDiagram}
                    onRename={(name, newName) => void handleRename(name, newName)}
                    onDelete={(name) => void handleDelete(name)}
                    onCopyPath={handleCopySvgPath}
                  />
                ))}
                <Card
                  interactive
                  onClick={() => { setNewName(""); setNewNameError(""); setNewDialogOpen(true); }}
                  style={{
                    padding: 8, display: "flex", flexDirection: "column",
                    alignItems: "center", justifyContent: "center", gap: 6,
                    cursor: "pointer", border: "1.5px dashed var(--bp-surface-border-color-default)",
                    boxShadow: "none", minHeight: 108, background: "transparent",
                  }}
                >
                  <Icon icon="plus" size={20} color="var(--bp-typography-color-muted)" />
                  <span style={{ fontSize: 11, color: "var(--bp-typography-color-muted)" }}>New Diagram</span>
                </Card>
              </div>
            )
          )}

          {/* Active diagram editor */}
          {activeDiagram !== null && (
            <div
              style={
                isFullscreen
                  ? { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }
                  : { display: "flex", flexDirection: "column" }
              }
            >
              {/* Tab strip */}
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  borderBottom: "1px solid var(--bp-surface-border-color-default)",
                  marginBottom: 4,
                  flexShrink: 0,
                  overflowX: "auto",
                }}
              >
                {openDiagrams.map((name) => (
                  <div
                    key={name}
                    onClick={() => setActiveDiagram(name)}
                    style={{
                      display: "flex", alignItems: "center", gap: 4,
                      padding: "4px 10px 4px",
                      cursor: "pointer", flexShrink: 0,
                      borderBottom: name === activeDiagram
                        ? "2px solid var(--bp-intent-primary-default-color)"
                        : "2px solid transparent",
                      color: name === activeDiagram
                        ? "var(--bp-typography-color-default)"
                        : "var(--bp-typography-color-muted)",
                      userSelect: "none",
                    }}
                  >
                    <span style={{ fontSize: 11, fontFamily: "var(--bp-typography-family-mono)" }}>
                      docs/diagrams/{name}.svg
                    </span>
                    <span
                      onClick={(e) => { e.stopPropagation(); closeTab(name); }}
                      style={{ cursor: "pointer", fontSize: 14, lineHeight: 1, opacity: 0.5, marginLeft: 2 }}
                    >×</span>
                  </div>
                ))}
              </div>

              {/* Canvas container */}
              <div
                ref={canvasContainerRef}
                style={
                  isFullscreen
                    ? {
                        position: "relative",
                        flex: 1,
                        minHeight: 0,
                        border: "1px solid var(--bp-surface-border-color-default)",
                        borderRadius: 3,
                        overflow: "hidden",
                      }
                    : {
                        position: "relative",
                        height: 550,
                        border: "1px solid var(--bp-surface-border-color-default)",
                        borderRadius: 3,
                        overflow: "hidden",
                      }
                }
              >
                <DiagramEditor
                  key={`${activeDiagram}:${diagramReloadCounts[activeDiagram] ?? 0}`}
                  ref={editorRef}
                  name={activeDiagram}
                  initialData={diagramContents[activeDiagram] ?? ""}
                  isDark={isDark}
                  onSave={handleSave}
                  onStatusChange={setSaveStatus}
                />

                {/* View-mode overlay — blocks scroll interference and shows edit hint.
                    Hidden in fullscreen (lock icon in header is the entry point there). */}
                {!isEditing && !isFullscreen && (
                  <div
                    onClick={isAcquiringLock ? undefined : () => { void handleEditClick(); }}
                    style={{
                      position: "absolute", inset: 0, zIndex: 10,
                      cursor: isAcquiringLock ? "wait" : "pointer",
                    }}
                  >
                    {isAcquiringLock ? (
                      <div style={{ position: "absolute", top: 8, right: 8, pointerEvents: "none" }}>
                        <Spinner size={14} />
                      </div>
                    ) : (
                      <div
                        className="canvas-edit-hint"
                        style={{
                          position: "absolute", inset: 0,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          opacity: 0,
                          transition: "opacity 0.15s",
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0"; }}
                      >
                        <span
                          style={{
                            fontSize: 11,
                            padding: "3px 8px",
                            borderRadius: 3,
                            background: "rgba(0,0,0,0.35)",
                            color: "#fff",
                            pointerEvents: "none",
                            userSelect: "none",
                          }}
                        >
                          {lockDeniedMs !== null ? "Locked by another session" : "Click to edit"}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* New Diagram Dialog */}
      <Dialog isOpen={newDialogOpen} onClose={() => setNewDialogOpen(false)} title="New Diagram" style={{ width: 360 }}>
        <DialogBody>
          <InputGroup
            autoFocus
            placeholder="Diagram name"
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setNewNameError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") void handleCreateDiagram(); }}
            intent={newNameError ? "danger" : "none"}
          />
          {newNameError && (
            <p style={{ color: "var(--bp-intent-danger-default-color)", fontSize: 12, margin: "6px 0 0" }}>
              {newNameError}
            </p>
          )}
        </DialogBody>
        <DialogFooter
          actions={
            <>
              <Button text="Cancel" onClick={() => setNewDialogOpen(false)} />
              <Button intent="primary" text="Create" onClick={() => void handleCreateDiagram()} />
            </>
          }
        />
      </Dialog>
    </div>
  );
}

// ── DiagramCard ──────────────────────────────────────────────────────────────

interface DiagramCardProps {
  diagram: DiagramMeta;
  repoPath: string;
  isActive: boolean;
  svgVersion: number;
  onOpen: (name: string) => void;
  onRename: (name: string, newName: string) => void;
  onDelete: (name: string) => void;
  onCopyPath: (name: string) => void;
}

function DiagramCard({ diagram, repoPath, isActive, svgVersion, onOpen, onRename, onDelete, onCopyPath }: DiagramCardProps) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <Card
      interactive={!isActive}
      onClick={() => !isActive && onOpen(diagram.name)}
      style={{
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        cursor: isActive ? "default" : "pointer",
        border: isActive ? "2px solid var(--bp-intent-primary-default-color)" : undefined,
        boxShadow: "none",
        minHeight: 108,
      }}
    >
      {diagram.hasSvg ? (
        <img
          src={`/api/diagrams/svg?path=${encodeURIComponent(repoPath)}&name=${encodeURIComponent(diagram.name)}&v=${svgVersion}`}
          alt={diagram.name}
          style={{ width: "100%", height: 72, objectFit: "contain", borderRadius: 2 }}
        />
      ) : (
        <div style={{ width: "100%", height: 72, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon icon="media" size={24} color="var(--bp-typography-color-muted)" />
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 2, minWidth: 0 }}>
        <span
          style={{
            flex: 1,
            fontSize: 11,
            fontFamily: "var(--bp-typography-family-mono)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {diagram.name}
        </span>
        <Popover
          isOpen={renameOpen}
          onInteraction={(next) => { if (!next) setRenameOpen(false); }}
          placement="bottom-end"
          content={
            <div style={{ padding: 12, width: 200 }} onClick={(e) => e.stopPropagation()}>
              <InputGroup
                small autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { onRename(diagram.name, renameValue); setRenameOpen(false); }
                  if (e.key === "Escape") setRenameOpen(false);
                }}
              />
              <div style={{ marginTop: 8, display: "flex", gap: 4, justifyContent: "flex-end" }}>
                <Button small text="Cancel" onClick={() => setRenameOpen(false)} />
                <Button small intent="primary" text="Rename" onClick={() => { onRename(diagram.name, renameValue); setRenameOpen(false); }} />
              </div>
            </div>
          }
        >
          <Tooltip content="Rename" placement="bottom" disabled={renameOpen}>
            <Button
              small variant="minimal" icon="edit"
              onClick={(e) => { e.stopPropagation(); setRenameValue(diagram.name); setRenameOpen(true); }}
              style={{ minWidth: 0, flexShrink: 0 }}
            />
          </Tooltip>
        </Popover>
        <Tooltip content="Copy SVG path" placement="bottom">
          <Button
            small variant="minimal" icon="clipboard"
            onClick={(e) => { e.stopPropagation(); onCopyPath(diagram.name); }}
            style={{ minWidth: 0, flexShrink: 0 }}
          />
        </Tooltip>
        <Popover
          isOpen={deleteOpen}
          onInteraction={(next) => { if (!next) setDeleteOpen(false); }}
          placement="bottom-end"
          content={
            <div style={{ padding: 12 }} onClick={(e) => e.stopPropagation()}>
              <p style={{ margin: "0 0 8px", fontSize: 13 }}>Delete "{diagram.name}"?</p>
              <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                <Button small text="Cancel" onClick={() => setDeleteOpen(false)} />
                <Button small text="Delete" onClick={() => { onDelete(diagram.name); setDeleteOpen(false); }} />
              </div>
            </div>
          }
        >
          <Tooltip content="Delete" placement="bottom" disabled={deleteOpen}>
            <Button
              small variant="minimal" icon="trash"
              onClick={(e) => { e.stopPropagation(); setDeleteOpen(true); }}
              style={{ minWidth: 0, flexShrink: 0 }}
            />
          </Tooltip>
        </Popover>
      </div>
    </Card>
  );
}
