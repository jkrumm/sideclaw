import React, {
  use,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Callout, Popover, Spinner, Tag, Tree } from "@blueprintjs/core";
import type { TreeNodeInfo } from "@blueprintjs/core";
import { api } from "../lib/api";
import { MarkdownEditor } from "./MarkdownEditor";
import type { RepoData } from "../types";

export interface NotesPanelHandle {
  notifyExternal: (sourceTabId?: string) => void;
}

interface Props {
  repoPath: string;
  initialPromise: Promise<RepoData>;
  ref?: React.Ref<NotesPanelHandle>;
}

// Build Blueprint Tree nodes from flat file paths
function buildFileTree(
  files: string[],
  expandedFolders: Set<string>,
  selectedFile: string | null,
): TreeNodeInfo[] {
  interface DirNode {
    children: Map<string, DirNode>;
    files: string[];
    path: string;
  }

  const root: DirNode = { children: new Map(), files: [], path: "" };

  for (const file of files) {
    const parts = file.split("/");
    let current = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i];
      const dirPath = parts.slice(0, i + 1).join("/");
      let next = current.children.get(dir);
      if (!next) {
        next = { children: new Map(), files: [], path: dirPath };
        current.children.set(dir, next);
      }
      current = next;
    }

    current.files.push(file);
  }

  function toTreeNodes(node: DirNode): TreeNodeInfo[] {
    const nodes: TreeNodeInfo[] = [];

    const dirs = [...node.children.entries()].toSorted((a, b) => a[0].localeCompare(b[0]));
    for (const [name, child] of dirs) {
      const isExpanded = expandedFolders.has(child.path);
      nodes.push({
        id: child.path,
        label: name,
        icon: isExpanded ? "folder-open" : "folder-close",
        isExpanded,
        childNodes: toTreeNodes(child),
      });
    }

    for (const file of node.files.toSorted()) {
      const fileName = file.split("/").at(-1) ?? "";
      nodes.push({
        id: file,
        label: fileName,
        icon: "document",
        isSelected: file === selectedFile,
      });
    }

    return nodes;
  }

  return toTreeNodes(root);
}

export function NotesPanel({ repoPath, initialPromise, ref }: Props) {
  const initial = use(initialPromise);
  const tabId = useRef(`tab-${Math.random().toString(36).slice(2)}`).current;
  const [externallyChanged, setExternallyChanged] = useState(false);

  const notifyExternal = useCallback(
    (sourceTabId?: string) => {
      if (sourceTabId !== tabId) setExternallyChanged(true);
    },
    [tabId],
  );

  useImperativeHandle(ref, () => ({ notifyExternal }), [notifyExternal]);

  const [collapsed, setCollapsed] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState(initial.notes);
  const [cnoteVersion, setCnoteVersion] = useState(0);
  const [modifiedAt, setModifiedAt] = useState(initial.notesModifiedAt);
  const [conflictDetected, setConflictDetected] = useState(false);
  const [fileVersion, setFileVersion] = useState(0);
  const [mdFiles, setMdFiles] = useState<string[] | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);

  const storagePrefix = `sideclaw:${repoPath}`;

  const [openTabs, setOpenTabs] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(`${storagePrefix}:openTabs`) ?? "[]");
    } catch {
      return [];
    }
  });

  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(`${storagePrefix}:mdTreeExpanded`);
      if (stored) return new Set(JSON.parse(stored));
    } catch {
      /* ignore */
    }
    return new Set(["docs"]);
  });

  // Eagerly fetch markdown files to detect README and populate tree
  useEffect(() => {
    api.api["markdown-files"].get({ query: { path: repoPath } }).then((res) => {
      if (res.data?.ok) setMdFiles(res.data.data as string[]);
    });
  }, [repoPath]);

  const readmeFile = useMemo(
    () => mdFiles?.find((f) => f.toLowerCase() === "readme.md") ?? null,
    [mdFiles],
  );

  const saveOpenTabs = (tabs: string[]) => {
    setOpenTabs(tabs);
    localStorage.setItem(`${storagePrefix}:openTabs`, JSON.stringify(tabs));
  };

  const handleFileSelect = async (file: string) => {
    if (selectedFile === file) {
      setTreeOpen(false);
      return;
    }
    const res = await api.api["markdown-file"]
      .get({ query: { path: repoPath, file } })
      .catch(() => null);
    if (res?.data?.ok) {
      setSelectedFile(file);
      setEditorContent(res.data.data as string);
      setFileVersion((v) => v + 1);
      setTreeOpen(false);
      // Add to openTabs if not pinned and not already open
      if (file !== readmeFile && !openTabs.includes(file)) {
        saveOpenTabs([...openTabs, file]);
      }
    } else {
      // Remove from openTabs if it failed to load (file likely deleted)
      if (openTabs.includes(file)) {
        saveOpenTabs(openTabs.filter((f) => f !== file));
      }
    }
  };

  const handleSwitchToCnote = async () => {
    if (!selectedFile) return;
    const res = await api.api.notes.get({ query: { path: repoPath } }).catch(() => null);
    const content = res?.data?.ok ? (res.data.data as string) : "";
    setSelectedFile(null);
    setEditorContent(content);
    setCnoteVersion((v) => v + 1);
  };

  const handleCloseTab = async (file: string) => {
    saveOpenTabs(openTabs.filter((f) => f !== file));
    if (selectedFile === file) {
      const res = await api.api.notes.get({ query: { path: repoPath } }).catch(() => null);
      const content = res?.data?.ok ? (res.data.data as string) : "";
      setSelectedFile(null);
      setEditorContent(content);
      setCnoteVersion((v) => v + 1);
    }
  };

  const handleCnoteReload = async () => {
    const res = await api.api.notes.get({ query: { path: repoPath } }).catch(() => null);
    if (res?.data?.ok) {
      const d = res.data as { ok: true; data: string; modifiedAt: number };
      setEditorContent(d.data);
      setModifiedAt(d.modifiedAt ?? 0);
      setCnoteVersion((v) => v + 1);
      setConflictDetected(false);
    }
    setExternallyChanged(false);
  };

  const persistExpansion = (next: Set<string>) => {
    setExpandedFolders(next);
    localStorage.setItem(`${storagePrefix}:mdTreeExpanded`, JSON.stringify([...next]));
  };

  const handleTreeNodeClick = (node: TreeNodeInfo) => {
    if (node.childNodes) {
      const next = new Set(expandedFolders);
      if (next.has(node.id as string)) next.delete(node.id as string);
      else next.add(node.id as string);
      persistExpansion(next);
    } else {
      handleFileSelect(node.id as string);
    }
  };

  const handleNodeExpand = (node: TreeNodeInfo) => {
    const next = new Set(expandedFolders);
    next.add(node.id as string);
    persistExpansion(next);
  };

  const handleNodeCollapse = (node: TreeNodeInfo) => {
    const next = new Set(expandedFolders);
    next.delete(node.id as string);
    persistExpansion(next);
  };

  const treeNodes = useMemo(
    () => (mdFiles ? buildFileTree(mdFiles, expandedFolders, selectedFile) : []),
    [mdFiles, expandedFolders, selectedFile],
  );

  const editorSave = selectedFile
    ? (content: string) =>
        api.api["markdown-file"].put({ content }, { query: { path: repoPath, file: selectedFile } })
    : async (content: string) => {
        const params = new URLSearchParams({
          path: repoPath,
          tabId,
          ...(modifiedAt ? { modifiedAt: String(modifiedAt) } : {}),
        });
        const res = await fetch(`/api/notes?${params}`, {
          method: "PUT",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        if (res.status === 409) {
          setConflictDetected(true);
          return;
        }
        if (res.ok) {
          const json = (await res.json()) as { ok: boolean; modifiedAt?: number };
          if (json.ok && json.modifiedAt) {
            setModifiedAt(json.modifiedAt);
            setConflictDetected(false);
          }
        }
      };

  const contentKey = selectedFile ? `${selectedFile}:${fileVersion}` : `sc-note:${cnoteVersion}`;

  // Tabs to show in the strip (exclude readme from openTabs since it's pinned)
  const closableTabs = openTabs.filter((f) => f !== readmeFile);

  return (
    <div>
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
          minWidth: 0,
        }}
      >
        <p className="section-label" style={{ flexShrink: 0 }}>
          Notes
        </p>
        <Button
          variant="minimal"
          small
          icon={collapsed ? "chevron-right" : "chevron-down"}
          onClick={() => setCollapsed((c) => !c)}
          style={{ flexShrink: 0 }}
        />

        {!collapsed && (
          <>
            {/* Horizontally scrollable tab strip */}
            <div
              className="notes-tab-strip"
              style={{
                flex: 1,
                minWidth: 0,
                overflowX: "auto",
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "2px 2px",
                scrollbarWidth: "none",
              }}
            >
              {/* CNote — pinned, no close */}
              <Tag
                interactive
                minimal={selectedFile !== null}
                intent="none"
                onClick={handleSwitchToCnote}
                style={{ flexShrink: 0, cursor: "pointer" }}
              >
                CNote
              </Tag>

              {/* README — pinned, no close (shown once mdFiles loaded) */}
              {readmeFile && (
                <Tag
                  interactive
                  minimal={selectedFile !== readmeFile}
                  intent="none"
                  onClick={() => handleFileSelect(readmeFile)}
                  style={{ flexShrink: 0, cursor: "pointer" }}
                >
                  README
                </Tag>
              )}

              {/* Closeable tabs */}
              {closableTabs.map((file) => {
                const name = file.split("/").at(-1) ?? "";
                const isActive = selectedFile === file;
                return (
                  <Tag
                    key={file}
                    interactive
                    minimal={!isActive}
                    intent="none"
                    onRemove={(e) => {
                      e.stopPropagation();
                      handleCloseTab(file);
                    }}
                    onClick={() => handleFileSelect(file)}
                    style={{ flexShrink: 0, cursor: "pointer" }}
                  >
                    {name}
                  </Tag>
                );
              })}
            </div>

            {/* All MDs button — stays on right */}
            <Popover
              content={
                <div
                  className="md-file-tree"
                  style={{
                    maxHeight: 300,
                    overflowY: "auto",
                    minWidth: 220,
                    padding: 4,
                  }}
                >
                  {mdFiles === null ? (
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "center",
                        padding: 16,
                      }}
                    >
                      <Spinner size={20} />
                    </div>
                  ) : mdFiles.length === 0 ? (
                    <div style={{ padding: 8, opacity: 0.5, fontSize: 12 }}>
                      No markdown files found
                    </div>
                  ) : (
                    <Tree
                      contents={treeNodes}
                      onNodeClick={handleTreeNodeClick}
                      onNodeExpand={handleNodeExpand}
                      onNodeCollapse={handleNodeCollapse}
                    />
                  )}
                </div>
              }
              placement="bottom-end"
              minimal
              isOpen={treeOpen}
              onInteraction={(next) => setTreeOpen(next)}
            >
              <Button
                small
                text="All MDs"
                variant="outlined"
                rightIcon="caret-down"
                style={{ flexShrink: 0 }}
              />
            </Popover>
          </>
        )}
      </div>

      {/* External change warning (sc-note only) */}
      {externallyChanged && !selectedFile && !collapsed && (
        <Callout intent="warning" style={{ marginBottom: 8 }}>
          Notes changed externally —{" "}
          <Button variant="minimal" small onClick={handleCnoteReload}>
            Reload
          </Button>
        </Callout>
      )}

      {/* Save conflict: file changed on disk since last load */}
      {conflictDetected && !selectedFile && !collapsed && (
        <Callout intent="danger" style={{ marginBottom: 8 }}>
          Save conflict — file was modified externally. Your changes were not saved.{" "}
          <Button variant="minimal" small onClick={handleCnoteReload}>
            Reload and discard
          </Button>
        </Callout>
      )}

      {/* Editor — always mounted, hidden when collapsed */}
      <div style={{ display: collapsed ? "none" : "block" }}>
        <MarkdownEditor
          content={editorContent}
          contentKey={contentKey}
          onSave={editorSave}
          placeholder={selectedFile ? `Editing ${selectedFile}...` : "Session notes..."}
        />
      </div>
    </div>
  );
}
