import React, { use, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  AnchorButton,
  Button,
  Callout,
  H6,
  Icon,
  Intent,
  Popover,
  Tag,
  Tooltip,
} from "@blueprintjs/core";
import type { GitFile, GitCommit, GitStatus, GithubData, WorkflowRun, Worktree } from "../types";
import { ChainDrawer } from "./ChainDrawer";

export interface GitPanelHandle {
  refresh: () => void;
}

interface Props {
  repoPath: string;
  initialPromise: Promise<GitStatus | null>;
  ref?: React.Ref<GitPanelHandle>;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <H6 style={{ margin: "0 0 6px", opacity: 0.65, fontSize: 12 }}>{children}</H6>;
}

const mono: React.CSSProperties = {
  fontFamily: "var(--bp-typography-family-mono)",
};

// ─── File tree ───────────────────────────────────────────────────────────────

type FileTreeNode =
  | { type: "dir"; name: string; path: string; children: FileTreeNode[] }
  | { type: "file"; name: string; path: string; file: GitFile };

function sortNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  const sorted = nodes.toSorted((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of sorted) {
    if (node.type === "dir") node.children = sortNodes(node.children);
  }
  return sorted;
}

function buildFileTree(files: GitFile[]): FileTreeNode[] {
  const dirMap = new Map<string, Extract<FileTreeNode, { type: "dir" }>>();
  const roots: FileTreeNode[] = [];
  function ensureDir(dirPath: string): Extract<FileTreeNode, { type: "dir" }> {
    const existing = dirMap.get(dirPath);
    if (existing) return existing;
    const parts = dirPath.split("/");
    const name = parts.at(-1) ?? "";
    const parentPath = parts.slice(0, -1).join("/");
    const node: Extract<FileTreeNode, { type: "dir" }> = {
      type: "dir",
      name,
      path: dirPath,
      children: [],
    };
    dirMap.set(dirPath, node);
    if (parentPath) ensureDir(parentPath).children.push(node);
    else roots.push(node);
    return node;
  }
  for (const file of files) {
    const parts = file.path.split("/");
    const filename = parts.at(-1) ?? "";
    const dirPath = parts.slice(0, -1).join("/");
    const leaf: FileTreeNode = { type: "file", name: filename, path: file.path, file };
    if (dirPath) ensureDir(dirPath).children.push(leaf);
    else roots.push(leaf);
  }
  return sortNodes(roots);
}

function fileStatusColor(status: GitFile["status"]): string {
  if (status === "M") return "#e6a817";
  if (status === "A") return "#23a26d";
  if (status === "D") return "#e05252";
  if (status === "R") return "#4c7ef3";
  return "#738091";
}

function renderNodes(nodes: FileTreeNode[], depth: number): React.ReactElement[] {
  return nodes.flatMap((node) => {
    const indent = 10 + depth * 14;
    if (node.type === "dir") {
      return [
        <div
          key={`dir-${node.path}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "3px 12px 2px",
            paddingLeft: indent,
            opacity: 0.5,
            fontSize: 11,
            ...mono,
          }}
        >
          <Icon icon="folder-close" size={11} />
          <span>{node.name}</span>
        </div>,
        ...renderNodes(node.children, depth + 1),
      ];
    }
    return [
      <div
        key={`file-${node.path}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "2px 12px",
          paddingLeft: indent,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: fileStatusColor(node.file.status),
            width: 10,
            textAlign: "center",
            ...mono,
          }}
        >
          {node.file.status}
        </span>
        <span style={{ fontSize: 12, ...mono }}>{node.name}</span>
        {node.file.staged && (
          <span
            style={{
              fontSize: 9,
              opacity: 0.45,
              border: "1px solid currentColor",
              borderRadius: 2,
              padding: "0 3px",
            }}
          >
            staged
          </span>
        )}
      </div>,
    ];
  });
}

function FileTreePopover({ files }: { files: GitFile[] }) {
  const tree = buildFileTree(files);
  return (
    <div style={{ minWidth: 260, maxHeight: 380, overflow: "auto", padding: "6px 0" }}>
      {renderNodes(tree, 0)}
    </div>
  );
}

// ─── Status dot ──────────────────────────────────────────────────────────────

function StatusDot({
  lastRefresh,
  githubLoading,
  onRefresh,
}: {
  lastRefresh: Date | null;
  githubLoading: boolean;
  onRefresh: () => void;
}) {
  const [bright, setBright] = useState(false);
  const [, setTick] = useState(0);
  const prevLoadingRef = useRef(githubLoading);

  useEffect(() => {
    if (prevLoadingRef.current && !githubLoading && lastRefresh) {
      setBright(true);
      const t = setTimeout(() => setBright(false), 1800);
      return () => clearTimeout(t);
    }
    prevLoadingRef.current = githubLoading;
  }, [githubLoading, lastRefresh]);

  useEffect(() => {
    const interval = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Tooltip
      content={
        lastRefresh
          ? `GitHub: ${timeAgo(lastRefresh.toISOString())} · click to refresh`
          : "GitHub: click to refresh"
      }
      placement="bottom"
    >
      <div
        onClick={onRefresh}
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: lastRefresh ? "#23a26d" : "#738091",
          opacity: bright ? 1 : 0.5,
          transition: bright ? "none" : "opacity 1.5s ease-out",
          cursor: "pointer",
          flexShrink: 0,
        }}
      />
    </Tooltip>
  );
}

// ─── Row 1: Status sections ──────────────────────────────────────────────────

function LocalSection({ gitStatus }: { gitStatus: GitStatus }) {
  const { branch, ahead, behind, changedFiles, mainBranch } = gitStatus;
  const modified = changedFiles.filter((f) => f.status === "M" || f.status === "R").length;
  const added = changedFiles.filter((f) => f.status === "A").length;
  const deleted = changedFiles.filter((f) => f.status === "D").length;
  const untracked = changedFiles.filter((f) => f.status === "?").length;
  const totalChanged = changedFiles.length;

  return (
    <div style={{ flex: "0 0 auto", minWidth: 0 }}>
      <SectionLabel>Local</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
        <Tooltip content={`Current branch (main: ${mainBranch})`} placement="bottom">
          <Tag minimal icon="git-branch" style={mono}>
            {branch}
          </Tag>
        </Tooltip>
        {ahead > 0 && (
          <Tooltip
            content={`${ahead} commit${ahead !== 1 ? "s" : ""} ahead of remote`}
            placement="bottom"
          >
            <Tag intent={Intent.SUCCESS} minimal>
              ↑{ahead}
            </Tag>
          </Tooltip>
        )}
        {behind > 0 && (
          <Tooltip
            content={`${behind} commit${behind !== 1 ? "s" : ""} behind remote`}
            placement="bottom"
          >
            <Tag intent={Intent.DANGER} minimal>
              ↓{behind}
            </Tag>
          </Tooltip>
        )}
        {totalChanged > 0 && (
          <Popover
            content={<FileTreePopover files={changedFiles} />}
            interactionKind="click"
            placement="bottom-start"
          >
            <Tooltip
              content={`${modified > 0 ? `M:${modified} ` : ""}${added > 0 ? `A:${added} ` : ""}${deleted > 0 ? `D:${deleted} ` : ""}${untracked > 0 ? `?:${untracked}` : ""}`.trim()}
              placement="bottom"
            >
              <Tag minimal intent={Intent.WARNING} style={{ cursor: "pointer" }} icon="document">
                {totalChanged} file{totalChanged !== 1 ? "s" : ""}
              </Tag>
            </Tooltip>
          </Popover>
        )}
      </div>
    </div>
  );
}

function WorktreesSection({ worktrees }: { worktrees: Worktree[] }) {
  const nonMain = worktrees.filter((w) => !w.isMain);
  if (worktrees.length <= 1) return null;

  const content = (
    <div style={{ padding: "8px 12px", minWidth: 200 }}>
      <SectionLabel>Worktrees</SectionLabel>
      {worktrees.map((w) => (
        <div
          key={w.path}
          style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}
        >
          <Icon icon={w.isMain ? "home" : "git-branch"} size={12} style={{ opacity: 0.55 }} />
          <span style={{ fontSize: 12, ...mono }}>{w.branch}</span>
          {w.isMain && <span style={{ fontSize: 10, opacity: 0.45 }}>main</span>}
        </div>
      ))}
    </div>
  );

  return (
    <div style={{ flex: "0 0 auto" }}>
      <SectionLabel>Worktrees</SectionLabel>
      <Popover content={content} interactionKind="click" placement="bottom-start">
        <div style={{ display: "flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
          <Tag minimal icon="layers">
            {worktrees.length}
          </Tag>
          {nonMain.slice(0, 2).map((w) => (
            <Tag key={w.path} minimal style={mono}>
              {truncate(w.branch, 20)}
            </Tag>
          ))}
          {nonMain.length > 2 && <Tag minimal>+{nonMain.length - 2}</Tag>}
        </div>
      </Popover>
    </div>
  );
}

function PRsSection({ githubData }: { githubData: GithubData | null }) {
  if (!githubData) return null;
  const { currentPR, openPRs } = githubData;
  if (!currentPR && openPRs.length === 0) return null;

  // Deduplicate: current PR is always shown first with CI info; others listed plain
  const otherPRs = openPRs.filter((p) => p.number !== currentPR?.number);

  function ciTag(pr: typeof currentPR) {
    if (!pr) return null;
    const { checks } = pr;
    if (checks.total === 0) return null;
    if (checks.failing > 0)
      return (
        <Tag intent={Intent.DANGER} minimal icon="error">
          {checks.failing} failing
        </Tag>
      );
    if (checks.pending > 0)
      return (
        <Tag intent={Intent.WARNING} minimal icon="time">
          {checks.passing}/{checks.total}
        </Tag>
      );
    return (
      <Tag intent={Intent.SUCCESS} minimal icon="tick-circle">
        {checks.passing}/{checks.total}
      </Tag>
    );
  }

  function reviewTag(pr: typeof currentPR) {
    if (!pr?.reviewDecision) return null;
    if (pr.reviewDecision === "APPROVED")
      return (
        <Tag intent={Intent.SUCCESS} minimal icon="endorsed">
          Approved
        </Tag>
      );
    if (pr.reviewDecision === "CHANGES_REQUESTED")
      return (
        <Tag intent={Intent.DANGER} minimal icon="comment">
          Changes
        </Tag>
      );
    if (pr.reviewDecision === "REVIEW_REQUIRED")
      return (
        <Tag minimal icon="comment">
          Review needed
        </Tag>
      );
    return null;
  }

  return (
    <div style={{ flex: "0 0 auto", minWidth: 0 }}>
      <SectionLabel>PRs</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
        {currentPR && (
          <>
            <Tooltip content={currentPR.title} placement="bottom">
              <AnchorButton
                variant="minimal"
                small
                href={currentPR.url}
                target="_blank"
                style={{ padding: "0 6px", fontSize: 12 }}
              >
                #{currentPR.number} {truncate(currentPR.title, 28)}
              </AnchorButton>
            </Tooltip>
            {ciTag(currentPR)}
            {reviewTag(currentPR)}
          </>
        )}
        {otherPRs.slice(0, 3).map((pr) => (
          <Tooltip key={pr.number} content={pr.title} placement="bottom">
            <AnchorButton
              variant="minimal"
              small
              href={pr.url}
              target="_blank"
              style={{ padding: "0 6px", fontSize: 12, opacity: 0.65 }}
            >
              #{pr.number}
            </AnchorButton>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

function VersionSection({
  gitStatus,
  githubData,
}: {
  gitStatus: GitStatus;
  githubData: GithubData | null;
}) {
  const { lastTag, distanceFromTag } = gitStatus;
  if (!lastTag) return null;

  const releaseUrl = githubData?.latestRelease?.url;

  return (
    <div style={{ flex: "0 0 auto" }}>
      <SectionLabel>Version</SectionLabel>
      <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
        <Tooltip content={releaseUrl ? "Latest release" : "Latest tag"} placement="bottom">
          {releaseUrl ? (
            <AnchorButton
              variant="minimal"
              small
              href={releaseUrl}
              target="_blank"
              icon="tag"
              style={{ ...mono, padding: "0 6px", fontSize: 12 }}
            >
              {lastTag}
            </AnchorButton>
          ) : (
            <Tag minimal icon="tag" style={mono}>
              {lastTag}
            </Tag>
          )}
        </Tooltip>
        {distanceFromTag > 0 && (
          <Tooltip
            content={`${distanceFromTag} commit${distanceFromTag !== 1 ? "s" : ""} on ${gitStatus.mainBranch} not yet released`}
            placement="bottom"
          >
            <Tag minimal intent={Intent.WARNING}>
              +{distanceFromTag}
            </Tag>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

// ─── Row 2 left: History ─────────────────────────────────────────────────────

function HistorySection({ gitStatus }: { gitStatus: GitStatus }) {
  const { branchCommits, masterCommits, branch, mainBranch } = gitStatus;
  const onMain = branch === mainBranch;

  // Build interleaved view: branch commits first (tagged), then master commits (tagged)
  type HistoryRow = { commit: GitCommit; label: string; isMain: boolean };
  const rows: HistoryRow[] = [];

  if (!onMain) {
    for (const c of branchCommits) rows.push({ commit: c, label: branch, isMain: false });
  }
  for (const c of masterCommits) {
    // Skip if already shown as branch commit
    if (rows.some((r) => r.commit.sha === c.sha)) continue;
    rows.push({ commit: c, label: mainBranch, isMain: true });
  }

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggle(sha: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });
  }

  return (
    <div style={{ flex: "1 1 0", minWidth: 0 }}>
      <SectionLabel>History</SectionLabel>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12, opacity: 0.4, display: "flex", alignItems: "center", gap: 6 }}>
          <Icon icon="tick-circle" size={12} />
          Up to date with {mainBranch}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {rows.map(({ commit, label, isMain }) => {
            const isExp = expanded.has(commit.sha);
            const hasBody = commit.body.length > 0;
            return (
              <div key={commit.sha}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "2px 0",
                    cursor: hasBody ? "pointer" : "default",
                  }}
                  onClick={() => hasBody && toggle(commit.sha)}
                >
                  <span style={{ fontSize: 10, opacity: 0.5, width: 42, flexShrink: 0, ...mono }}>
                    {commit.sha}
                  </span>
                  <Tag
                    minimal
                    style={{
                      fontSize: 10,
                      flexShrink: 0,
                      ...mono,
                      opacity: isMain ? 0.55 : 1,
                      maxWidth: 120,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {truncate(label, 16)}
                  </Tag>
                  <span
                    style={{
                      fontSize: 12,
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {commit.subject}
                  </span>
                  <span style={{ fontSize: 10, opacity: 0.4, flexShrink: 0, whiteSpace: "nowrap" }}>
                    {commit.relativeTime}
                  </span>
                  {hasBody && (
                    <Icon
                      icon={isExp ? "chevron-up" : "chevron-down"}
                      size={11}
                      style={{ opacity: 0.5, flexShrink: 0 }}
                    />
                  )}
                </div>
                {hasBody && isExp && (
                  <pre
                    style={{
                      fontSize: 11,
                      margin: "2px 0 4px 48px",
                      opacity: 0.65,
                      whiteSpace: "pre-wrap",
                      ...mono,
                    }}
                  >
                    {commit.body}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Row 2 right: Workflows ──────────────────────────────────────────────────

function WorkflowsSection({
  githubData,
  gitStatus,
}: {
  githubData: GithubData | null;
  gitStatus: GitStatus;
}) {
  if (!gitStatus.githubRepo || !githubData || githubData.workflowRuns.length === 0) return null;

  function runIcon(run: WorkflowRun) {
    if (run.status !== "completed") return <Icon icon="time" size={12} style={{ opacity: 0.6 }} />;
    if (run.conclusion === "success")
      return <Icon icon="tick-circle" size={12} intent={Intent.SUCCESS} />;
    return <Icon icon="error" size={12} intent={Intent.DANGER} />;
  }

  return (
    <div style={{ flex: "0 0 auto", width: 260 }}>
      <SectionLabel>Workflows</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {githubData.workflowRuns.map((run) => (
          <div key={run.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {runIcon(run)}
            <span
              style={{
                fontSize: 12,
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {truncate(run.name, 22)}
            </span>
            <span style={{ fontSize: 10, opacity: 0.4, whiteSpace: "nowrap" }}>
              {timeAgo(run.createdAt)}
            </span>
            <AnchorButton
              variant="minimal"
              icon="share"
              small
              href={run.url}
              target="_blank"
              style={{ padding: "0 2px", flexShrink: 0 }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Row 3: Actions ──────────────────────────────────────────────────────────

function BranchNameForm({
  label,
  onSubmit,
  onClose,
}: {
  label: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div style={{ padding: 16, minWidth: 240 }}>
      <SectionLabel>{label}</SectionLabel>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) onSubmit(value.trim());
          if (e.key === "Escape") onClose();
        }}
        placeholder="branch-name"
        style={{
          width: "100%",
          padding: "4px 8px",
          fontSize: 12,
          background: "var(--bp5-dark-gray5, #1c2127)",
          border: "1px solid var(--bp5-gray3, #5f6b7c)",
          borderRadius: 3,
          color: "inherit",
          ...mono,
          boxSizing: "border-box",
        }}
      />
      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <Button
          small
          intent={Intent.PRIMARY}
          disabled={!value.trim()}
          onClick={() => onSubmit(value.trim())}
        >
          Create
        </Button>
        <Button small onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ActionButton({
  label,
  intent,
  disabled,
  tooltip,
  popoverContent,
  onClick,
}: {
  label: string;
  intent?: Intent;
  disabled?: boolean;
  tooltip?: string;
  popoverContent?: React.ReactElement;
  onClick?: () => void;
}) {
  const [open, setOpen] = useState(false);

  const btn = (
    <Button
      fill
      outlined={!intent}
      small
      intent={intent}
      disabled={disabled}
      onClick={popoverContent ? () => setOpen(true) : onClick}
      style={{ whiteSpace: "nowrap" }}
    >
      {label}
    </Button>
  );

  const wrapped = tooltip ? (
    <Tooltip
      content={tooltip}
      placement="top"
      targetTagName="div"
      targetProps={{ style: { flex: 1, minWidth: 0 } }}
    >
      {btn}
    </Tooltip>
  ) : (
    <div style={{ flex: 1, minWidth: 0 }}>{btn}</div>
  );

  if (!popoverContent) return wrapped;

  return (
    <Popover
      isOpen={open}
      onClose={() => setOpen(false)}
      content={React.cloneElement(popoverContent, { onClose: () => setOpen(false) })}
      interactionKind="click"
      placement="top-start"
    >
      {wrapped}
    </Popover>
  );
}

// ─── Worktree selector ────────────────────────────────────────────────────────

function WorktreeSelector({
  worktrees,
  repoPath,
  selected,
  onSelect,
}: {
  worktrees: Worktree[];
  repoPath: string;
  selected: string;
  onSelect: (path: string) => void;
}) {
  // If only main worktree, nothing to select
  if (worktrees.length <= 1) return null;

  return (
    <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
      {worktrees.map((wt) => {
        const isSelected = selected === wt.path || (wt.isMain && selected === repoPath);
        return (
          <Tooltip
            key={wt.path}
            content={
              <div style={{ ...mono, fontSize: 11 }}>
                <div>{wt.path}</div>
                <div style={{ opacity: 0.6 }}>{wt.isMain ? "main worktree" : "worktree"}</div>
              </div>
            }
            placement="top"
          >
            <Button
              small
              outlined={!isSelected}
              intent={isSelected ? Intent.PRIMARY : undefined}
              onClick={() => onSelect(wt.path)}
              style={{ ...mono, fontSize: 11 }}
            >
              {wt.isMain ? "main" : truncate(wt.branch, 22)}
            </Button>
          </Tooltip>
        );
      })}
    </div>
  );
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function ActionsSection({
  repoPath,
  gitStatus,
  githubData,
}: {
  repoPath: string;
  gitStatus: GitStatus;
  githubData: GithubData | null;
}) {
  const { ahead, behind, branch, mainBranch } = gitStatus;
  const onMain = branch === mainBranch;
  const pr = githubData?.currentPR ?? null;

  // Default target: worktree matching current branch, or first worktree, or repoPath
  const defaultTarget =
    gitStatus.worktrees.find((wt) => wt.branch === branch)?.path ??
    gitStatus.worktrees[0]?.path ??
    repoPath;

  const [selectedPath, setSelectedPath] = useState(defaultTarget);
  const [chainJob, setChainJob] = useState<{ jobId: string; skill: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function showError(msg: string) {
    setError(msg);
    setTimeout(() => setError(null), 5000);
  }

  async function runChain(skill: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/actions/chain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill, worktreePath: selectedPath }),
      });
      const json = (await res.json()) as { ok: boolean; jobId?: string; error?: string };
      if (json.ok && json.jobId) {
        setChainJob({ jobId: json.jobId, skill });
      } else {
        showError(json.error ?? "Failed to start job");
      }
    } catch (e) {
      showError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runGitOp(op: string, name?: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/actions/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, worktreePath: selectedPath, name }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) showError(json.error ?? `${op} failed`);
    } catch (e) {
      showError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <SectionLabel>Actions</SectionLabel>

      <WorktreeSelector
        worktrees={gitStatus.worktrees}
        repoPath={repoPath}
        selected={selectedPath}
        onSelect={setSelectedPath}
      />

      {error && (
        <Callout
          intent={Intent.DANGER}
          style={{ marginBottom: 8, padding: "6px 10px", fontSize: 12 }}
        >
          {error}
        </Callout>
      )}

      <div
        style={{ display: "flex", gap: 5, alignItems: "stretch", width: "100%", flexWrap: "wrap" }}
      >
        <ActionButton
          label="New Branch"
          tooltip="Create a new branch from origin/default"
          disabled={busy}
          popoverContent={
            <BranchNameForm
              label="New Branch Name"
              onSubmit={(name) => {
                void runGitOp("new-branch", name);
              }}
              onClose={() => {}}
            />
          }
        />

        <ActionButton
          label="New Worktree"
          tooltip="Create a new worktree via wtp"
          disabled={busy}
          popoverContent={
            <BranchNameForm
              label="Worktree Branch Name"
              onSubmit={(name) => {
                void runGitOp("new-worktree", name);
              }}
              onClose={() => {}}
            />
          }
        />

        <ActionButton
          label={behind > 0 ? `Rebase (${behind})` : "Rebase"}
          tooltip={
            behind > 0
              ? `Rebase onto ${mainBranch} — ${behind} new commit${behind !== 1 ? "s" : ""}`
              : `Already up to date with ${mainBranch}`
          }
          disabled={onMain || behind === 0 || busy}
          onClick={() => {
            void runGitOp("rebase");
          }}
        />

        <ActionButton
          label={ahead > 0 ? `Push (${ahead})` : "Push"}
          tooltip={
            ahead > 0
              ? `Push ${ahead} commit${ahead !== 1 ? "s" : ""} → ${branch}`
              : "Nothing to push"
          }
          disabled={ahead === 0 || busy}
          popoverContent={
            <div style={{ padding: 16, minWidth: 220 }}>
              <SectionLabel>Push to remote</SectionLabel>
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12 }}>
                {ahead} commit{ahead !== 1 ? "s" : ""} → <span style={mono}>{branch}</span>
              </div>
              <Button
                small
                intent={Intent.PRIMARY}
                onClick={() => {
                  void runGitOp("push");
                }}
              >
                Push
              </Button>
            </div>
          }
        />

        <ActionButton
          label="GitCleanup"
          tooltip="Squash and group noisy commits into logical units"
          disabled={onMain || busy}
          onClick={() => {
            void runChain("/git-cleanup");
          }}
        />

        <ActionButton
          label="Validate"
          intent={Intent.SUCCESS}
          tooltip="Run format, lint, typecheck, and tests"
          disabled={busy}
          onClick={() => {
            void runChain("/check");
          }}
        />

        <ActionButton
          label="Review"
          intent={Intent.SUCCESS}
          tooltip="AI code review of branch changes"
          disabled={busy}
          onClick={() => {
            void runChain("/review");
          }}
        />

        <ActionButton
          label="Create PR"
          disabled={onMain || !!pr || busy}
          tooltip={
            pr
              ? `PR #${pr.number} already open`
              : onMain
                ? "Switch to a feature branch first"
                : "Run full PR chain: validate → review → create PR"
          }
          onClick={() => {
            void runChain("/pr create");
          }}
        />

        {pr && (
          <ActionButton
            label={`Merge #${pr.number}`}
            tooltip={`Merge PR #${pr.number}: ${truncate(pr.title, 30)}`}
            disabled={busy}
            popoverContent={
              <div style={{ padding: 16, minWidth: 220 }}>
                <SectionLabel>Merge PR</SectionLabel>
                <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12 }}>
                  #{pr.number} {truncate(pr.title, 32)}
                </div>
                <Button
                  small
                  intent={Intent.PRIMARY}
                  onClick={() => {
                    void runChain("/pr merge");
                  }}
                >
                  Merge
                </Button>
              </div>
            }
          />
        )}

        {gitStatus.distanceFromTag > 0 && (
          <ActionButton
            label={`Release (${gitStatus.distanceFromTag})`}
            intent={Intent.PRIMARY}
            tooltip={`${gitStatus.distanceFromTag} commit${gitStatus.distanceFromTag !== 1 ? "s" : ""} since ${gitStatus.lastTag} — release skill not yet implemented`}
            disabled
            popoverContent={
              <div style={{ padding: 16, minWidth: 220 }}>
                <SectionLabel>Release</SectionLabel>
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  Release skill coming soon — see sc-note todo #1.
                </div>
              </div>
            }
          />
        )}
      </div>

      <ChainDrawer
        jobId={chainJob?.jobId ?? null}
        skill={chainJob?.skill ?? ""}
        onClose={() => setChainJob(null)}
      />
    </div>
  );
}

// ─── Main GitPanel ────────────────────────────────────────────────────────────

export function GitPanel({ repoPath, initialPromise, ref }: Props) {
  const initialGit = use(initialPromise);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(initialGit);
  const [githubData, setGithubData] = useState<GithubData | null>(null);
  const [githubLoading, setGithubLoading] = useState(false);
  const [lastGithubRefresh, setLastGithubRefresh] = useState<Date | null>(null);

  const doFetchGithub = useCallback(async (git: GitStatus) => {
    if (!git.githubRepo) return;
    setGithubLoading(true);
    try {
      const res = await fetch(
        `/api/github?githubRepo=${encodeURIComponent(git.githubRepo)}&branch=${encodeURIComponent(git.branch)}`,
      );
      const json = (await res.json()) as { ok: boolean; data: GithubData };
      if (json.ok) {
        setGithubData(json.data);
        setLastGithubRefresh(new Date());
      }
    } catch {
      // GitHub data is optional — silently ignore failures
    } finally {
      setGithubLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    void (async () => {
      const res = await fetch(`/api/repo/git?path=${encodeURIComponent(repoPath)}`);
      const json = (await res.json()) as { ok: boolean; data: GitStatus | null };
      if (json.ok) {
        const newGit = json.data ?? null;
        setGitStatus(newGit);
        if (newGit?.githubRepo) void doFetchGithub(newGit);
      }
    })();
  }, [repoPath, doFetchGithub]);

  useImperativeHandle(ref, () => ({ refresh }), [refresh]);

  // Initial GitHub fetch once git data is available
  useEffect(() => {
    if (initialGit?.githubRepo) void doFetchGithub(initialGit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 15s polling
  useEffect(() => {
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!gitStatus) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Row 1: Status sections */}
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
        <LocalSection gitStatus={gitStatus} />
        {gitStatus.worktrees.length > 1 && <WorktreesSection worktrees={gitStatus.worktrees} />}
        {githubData && (githubData.currentPR || githubData.openPRs.length > 0) && (
          <PRsSection githubData={githubData} gitStatus={gitStatus} />
        )}
        {gitStatus.lastTag && <VersionSection gitStatus={gitStatus} githubData={githubData} />}
        {gitStatus.githubRepo && (
          <div style={{ marginLeft: "auto", alignSelf: "center" }}>
            <StatusDot
              lastRefresh={lastGithubRefresh}
              githubLoading={githubLoading}
              onRefresh={refresh}
            />
          </div>
        )}
      </div>

      {/* Row 2: History + Workflows */}
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
        <HistorySection gitStatus={gitStatus} />
        <WorkflowsSection githubData={githubData} gitStatus={gitStatus} />
      </div>

      {/* Row 3: Actions */}
      <ActionsSection repoPath={repoPath} gitStatus={gitStatus} githubData={githubData} />
    </div>
  );
}
