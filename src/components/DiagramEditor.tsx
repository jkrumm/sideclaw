import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { Spinner } from "@blueprintjs/core";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw";

export type SaveStatus = "idle" | "dirty" | "saving" | "synced";

export interface DiagramEditorHandle {
  save: () => void;
}

interface Props {
  name: string;
  initialData: string;
  isDark: boolean;
  onSave: (name: string, excalidraw: string, svg: string) => Promise<void>;
  onStatusChange: (status: SaveStatus) => void;
}

const ExcalidrawComponent = React.lazy(() =>
  import("./ExcalidrawLazy").catch((err) => {
    // Chunk hash changed after a rebuild — reload to pick up the new build
    if (import.meta.env.PROD) {
      window.location.reload();
      return new Promise<never>(() => {});
    }
    throw err;
  }),
);

export const DiagramEditor = React.forwardRef<DiagramEditorHandle, Props>(function DiagramEditor({
  name,
  initialData,
  isDark,
  onSave,
  onStatusChange,
}: Props, ref) {
  const excalidrawAPIRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Fingerprint of element ids+versions — changes only when actual drawing content changes,
  // not when the user scrolls/zooms/selects (appState-only changes).
  const elementsHashRef = useRef<string>("");
  const pendingSaveRef = useRef<{
    elements: Parameters<NonNullable<React.ComponentProps<typeof ExcalidrawComponent>["onChange"]>>[0];
    appState: Parameters<NonNullable<React.ComponentProps<typeof ExcalidrawComponent>["onChange"]>>[1];
    files: Parameters<NonNullable<React.ComponentProps<typeof ExcalidrawComponent>["onChange"]>>[2];
  } | null>(null);
  const statusRef = useRef<SaveStatus>("idle");
  const onSaveRef = useRef(onSave);
  const onStatusChangeRef = useRef(onStatusChange);

  // Keep refs up to date without re-creating callbacks
  onSaveRef.current = onSave;
  onStatusChangeRef.current = onStatusChange;

  const setStatus = useCallback((status: SaveStatus) => {
    statusRef.current = status;
    onStatusChangeRef.current(status);
  }, []);

  const parsedInitialData = useMemo(() => {
    if (!initialData) {
      return { elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {}, scrollToContent: true };
    }
    try {
      const parsed = JSON.parse(initialData) as {
        elements?: unknown[];
        appState?: Record<string, unknown>;
        files?: Record<string, unknown>;
      };
      return {
        elements: parsed.elements ?? [],
        appState: parsed.appState ?? {},
        files: parsed.files ?? {},
        scrollToContent: true,
      };
    } catch {
      return { elements: [], appState: {}, files: {}, scrollToContent: true };
    }
    // Only parse on mount — DiagramEditor remounts via key prop on diagram switch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doSave = useCallback(async () => {
    const pending = pendingSaveRef.current;
    if (!pending) return;

    pendingSaveRef.current = null;
    setStatus("saving");

    try {
      const { serializeAsJSON, exportToSvg } = await import("@excalidraw/excalidraw");

      const excalidrawJson = serializeAsJSON(
        pending.elements,
        pending.appState,
        pending.files,
        "local",
      );

      const svgEl = await exportToSvg({
        elements: pending.elements,
        appState: {
          ...pending.appState,
          exportWithDarkMode: false, // always export light-mode SVG for doc embedding
        },
        files: pending.files,
        exportPadding: 16,
      });

      const svgString = new XMLSerializer().serializeToString(svgEl);

      await onSaveRef.current(name, excalidrawJson, svgString);
      setStatus("synced");

      setTimeout(() => {
        if (statusRef.current === "synced") setStatus("idle");
      }, 2000);
    } catch (err) {
      console.error("[DiagramEditor] save failed:", err);
      setStatus("dirty");
    }
  }, [name, setStatus]);

  // Silent flush — used by blur / visibilitychange / unmount. No-op if nothing pending.
  const flushSave = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (pendingSaveRef.current) {
      void doSave();
    }
  }, [doSave]);

  // Explicit save — used by save button and Cmd+S. Always flashes green so the
  // user gets confirmation even when the file was already up to date.
  const explicitSave = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (pendingSaveRef.current) {
      void doSave();
    } else {
      setStatus("synced");
      setTimeout(() => {
        if (statusRef.current === "synced") setStatus("idle");
      }, 1500);
    }
  }, [doSave, setStatus]);

  useImperativeHandle(ref, () => ({ save: explicitSave }), [explicitSave]);

  const scheduleDebounce = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void doSave();
    }, 3_000);
  }, [doSave]);

  const handleChange = useCallback(
    (
      elements: Parameters<NonNullable<React.ComponentProps<typeof ExcalidrawComponent>["onChange"]>>[0],
      appState: Parameters<NonNullable<React.ComponentProps<typeof ExcalidrawComponent>["onChange"]>>[1],
      files: Parameters<NonNullable<React.ComponentProps<typeof ExcalidrawComponent>["onChange"]>>[2],
    ) => {
      // Always keep pendingSaveRef current so appState (viewport) is included in the next save.
      pendingSaveRef.current = { elements, appState, files };

      // Only mark dirty and trigger autosave when actual element content changes.
      // appState-only changes (scroll, zoom, selection) don't constitute unsaved work
      // and must not block conflict detection in the SSE sync logic.
      const hash = elements
        .map((e) => `${e.id}:${(e as { version?: number }).version ?? 0}`)
        .join(",");
      if (hash !== elementsHashRef.current) {
        elementsHashRef.current = hash;
        if (statusRef.current === "idle" || statusRef.current === "synced") {
          setStatus("dirty");
        }
        scheduleDebounce();
      }
    },
    [scheduleDebounce, setStatus],
  );

  // Flush on window blur, tab hide (app switch), or Cmd/Ctrl+S
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) flushSave(); };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        explicitSave();
      }
    };
    window.addEventListener("blur", flushSave);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("blur", flushSave);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("keydown", onKey);
    };
  }, [flushSave, explicitSave]);

  // Flush on unmount (diagram switch, panel collapse)
  useEffect(() => {
    return () => {
      flushSave();
    };
  }, [flushSave]);

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <React.Suspense
        fallback={
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              height: "100%",
            }}
          >
            <Spinner size={32} />
          </div>
        }
      >
        <ExcalidrawComponent
          initialData={parsedInitialData}
          excalidrawAPI={(api) => {
            excalidrawAPIRef.current = api;
          }}
          onChange={handleChange}
          theme={isDark ? "dark" : "light"}
          UIOptions={{
            canvasActions: {
              toggleTheme: null,
              export: false,
              saveToActiveFile: false,
            },
          }}
        />
      </React.Suspense>
    </div>
  );
});
