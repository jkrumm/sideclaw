import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alignment,
  Button,
  Navbar,
  NavbarGroup,
  NavbarHeading,
  NonIdealState,
} from "@blueprintjs/core";
import { GitPanel } from "../components/GitPanel";
import { UsageTags } from "../components/UsageTags";
import { QueuePanel } from "../components/QueuePanel";
import { NotesPanel } from "../components/NotesPanel";
import { DiagramPanel } from "../components/DiagramPanel";
import { PanelSkeleton } from "../components/PanelSkeleton";
import { useTheme } from "../main";
import type { GitPanelHandle } from "../components/GitPanel";
import type { QueuePanelHandle } from "../components/QueuePanel";
import type { NotesPanelHandle } from "../components/NotesPanel";
import type { GitStatus, RepoData } from "../types";

async function fetchRepoData(path: string): Promise<RepoData> {
  const res = await fetch(`/api/repo?path=${encodeURIComponent(path)}`);
  const json = (await res.json()) as { ok: boolean; data: RepoData };
  if (!json.ok) throw new Error("Failed to load repo");
  return json.data;
}

async function fetchGitData(path: string): Promise<GitStatus | null> {
  const res = await fetch(`/api/repo/git?path=${encodeURIComponent(path)}`);
  const json = (await res.json()) as { ok: boolean; data: GitStatus | null };
  if (!json.ok) throw new Error("Failed to load git status");
  return json.data;
}

class DashboardErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40 }}>
          <NonIdealState
            icon="error"
            title="Dashboard error"
            description={this.state.error.message}
          />
        </div>
      );
    }
    return this.props.children;
  }
}

function RepoDashboardInner() {
  const { workspace, repo } = useParams<{ workspace: string; repo: string }>();
  const navigate = useNavigate();
  const { mode, toggle } = useTheme();

  const repoPath = workspace && repo ? `/${workspace}/${repo}` : null;

  const [sseDisconnected, setSseDisconnected] = useState(false);

  const gitRef = useRef<GitPanelHandle>(null);
  const queueRef = useRef<QueuePanelHandle>(null);
  const notesRef = useRef<NotesPanelHandle>(null);
  const evtSourceRef = useRef<EventSource | null>(null);

  // Both promises fire immediately in parallel — no waterfall
  const repoPromise = useMemo(
    () => (repoPath ? fetchRepoData(repoPath) : Promise.reject(new Error("No path"))),
    [repoPath],
  );
  const gitPromise = useMemo(
    () => (repoPath ? fetchGitData(repoPath) : Promise.reject(new Error("No path"))),
    [repoPath],
  );

  // SSE — single connection per repo, dispatches to panel refs
  useEffect(() => {
    if (!repoPath) return;

    let isActive = true;
    let knownServerStart: number | null = null;
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

    const resetWatchdog = (evtSource: EventSource) => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        if (!isActive) return;
        evtSource.close();
        evtSourceRef.current = null;
        if (isActive) {
          setSseDisconnected(true);
          setTimeout(() => {
            if (isActive) {
              setSseDisconnected(false);
              connect();
            }
          }, 100);
        }
      }, 35_000);
    };

    const connect = () => {
      const evtSource = new EventSource(
        `/api/events?path=${encodeURIComponent(repoPath)}`,
      );
      evtSourceRef.current = evtSource;

      evtSource.addEventListener("connected", (e: MessageEvent) => {
        const data = JSON.parse(e.data as string) as { serverStart?: number };
        if (data.serverStart) {
          if (knownServerStart !== null && knownServerStart !== data.serverStart) {
            window.location.reload();
            return;
          }
          knownServerStart = data.serverStart;
        }
        // Refresh panels to catch any events missed during a disconnect gap
        queueRef.current?.refresh();
        gitRef.current?.refresh();
        resetWatchdog(evtSource);
      });

      evtSource.addEventListener("ping", () => resetWatchdog(evtSource));

      evtSource.addEventListener("change", (e: MessageEvent) => {
        resetWatchdog(evtSource);
        const payload = JSON.parse(e.data as string) as {
          file: "queue" | "notes" | "diagram";
          sourceTabId?: string;
        };
        if (payload.file === "queue") queueRef.current?.refresh();
        else if (payload.file === "notes") notesRef.current?.notifyExternal(payload.sourceTabId);
      });

      evtSource.onerror = () => {
        if (!isActive) return;
        if (watchdogTimer) {
          clearTimeout(watchdogTimer);
          watchdogTimer = null;
        }
        evtSource.close();
        evtSourceRef.current = null;
        const showTimer = setTimeout(() => {
          if (isActive) setSseDisconnected(true);
        }, 2000);
        setTimeout(() => {
          clearTimeout(showTimer);
          if (isActive) {
            setSseDisconnected(false);
            connect();
          }
        }, 5000);
      };
    };

    connect();

    return () => {
      isActive = false;
      if (watchdogTimer) clearTimeout(watchdogTimer);
      evtSourceRef.current?.close();
      evtSourceRef.current = null;
    };
  }, [repoPath]);

  if (!repoPath) {
    return (
      <div style={{ padding: 40 }}>
        <NonIdealState icon="error" title="Invalid path" />
      </div>
    );
  }

  const repoName = repoPath.split("/").pop() ?? repoPath;

  return (
    <div>
      <Navbar>
        <NavbarGroup align={Alignment.START}>
          <Button
            variant="minimal"
            icon="arrow-left"
            onClick={() => navigate("/")}
          />
          <NavbarHeading
            style={{ fontFamily: "var(--bp-typography-family-mono)" }}
          >
            {repoName}
          </NavbarHeading>
        </NavbarGroup>
        <NavbarGroup align={Alignment.END}>
          {sseDisconnected && (
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--bp5-intent-danger)",
                marginRight: 8,
                flexShrink: 0,
              }}
              title="Disconnected"
            />
          )}
          <UsageTags />
          <Button
            variant="minimal"
            icon={
              mode === "light" ? "moon" : mode === "dark" ? "desktop" : "flash"
            }
            onClick={toggle}
          />
        </NavbarGroup>
      </Navbar>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 24,
          padding: 24,
        }}
      >
        <Suspense fallback={<PanelSkeleton height={100} />}>
          <GitPanel
            key={repoPath}
            ref={gitRef}
            repoPath={repoPath}
            initialPromise={gitPromise}
          />
        </Suspense>
        <Suspense fallback={<PanelSkeleton height={160} />}>
          <QueuePanel
            key={repoPath}
            ref={queueRef}
            repoPath={repoPath}
            initialPromise={repoPromise}
          />
        </Suspense>
        <DiagramPanel repoPath={repoPath} />
        <Suspense fallback={<PanelSkeleton height={200} />}>
          <NotesPanel
            key={repoPath}
            ref={notesRef}
            repoPath={repoPath}
            initialPromise={repoPromise}
          />
        </Suspense>
      </div>
    </div>
  );
}

export function RepoDashboard() {
  return (
    <DashboardErrorBoundary>
      <RepoDashboardInner />
    </DashboardErrorBoundary>
  );
}
