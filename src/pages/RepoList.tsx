import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Alert,
  Alignment,
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogFooter,
  InputGroup,
  Intent,
  Menu,
  MenuItem,
  Navbar,
  NavbarDivider,
  NavbarGroup,
  NavbarHeading,
  NonIdealState,
  Spinner,
  Tag,
} from "@blueprintjs/core";
import { api } from "../lib/api";
import { UsageTags } from "../components/UsageTags";
import { useTheme } from "../main";
import type { RepoInfo } from "../types";

type Candidate = { name: string; workspace: string };

function workspaceLabel(path: string): string {
  return path.split("/").filter(Boolean)[0] ?? "unknown";
}

export function RepoList() {
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const { mode, toggle } = useTheme();

  // Init dialog
  const [initOpen, setInitOpen] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [initLoading, setInitLoading] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<RepoInfo | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  function loadRepos() {
    api.api.repos
      .get()
      .then(({ data, error }) => {
        if (error) {
          setFetchError(String(error));
          return;
        }
        if (data && data.ok) setRepos(data.data);
      })
      .catch((err: unknown) => setFetchError(String(err)));
  }

  useEffect(() => {
    loadRepos();
  }, []);

  function openInitDialog() {
    setSelected(null);
    setQuery("");
    setInitError(null);
    api.api.repos.candidates
      .get()
      .then(({ data }) => {
        if (data && data.ok) setCandidates(data.data);
      })
      .catch(() => {});
    setInitOpen(true);
  }

  async function handleInit() {
    if (!selected) return;
    setInitLoading(true);
    setInitError(null);
    const { data, error } = await api.api.repos.init.post({
      name: selected.name,
      workspace: selected.workspace,
    });
    setInitLoading(false);
    if (error || !data?.ok) {
      setInitError((data as { error?: string } | undefined)?.error ?? String(error));
      return;
    }
    setInitOpen(false);
    setSelected(null);
    loadRepos();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    await api.api.repos.remove.delete(undefined, { query: { path: deleteTarget.path } });
    setDeleteLoading(false);
    setDeleteTarget(null);
    loadRepos();
  }

  if (fetchError) {
    return (
      <div style={{ padding: 40 }}>
        <NonIdealState
          icon="error"
          title="Failed to load repos"
          description={fetchError}
        />
      </div>
    );
  }

  return (
    <div>
      <Navbar>
        <NavbarGroup align={Alignment.START}>
          <NavbarHeading
            style={{ fontFamily: "var(--bp-typography-family-default)", fontWeight: 700 }}
          >
            sideclaw
          </NavbarHeading>
          <NavbarDivider />
          <span style={{ opacity: 0.6, fontSize: 13 }}>
            Claude Code task queue dashboard
          </span>
        </NavbarGroup>
        <NavbarGroup align={Alignment.END}>
          <UsageTags />
          <Button variant="minimal" icon="add" text="Init repo" onClick={openInitDialog} />
          <NavbarDivider />
          <Button
            variant="minimal"
            icon={mode === "light" ? "moon" : mode === "dark" ? "desktop" : "flash"}
            onClick={toggle}
          />
        </NavbarGroup>
      </Navbar>

      <div style={{ padding: 24, maxWidth: 800, margin: "0 auto" }}>
        {!repos ? (
          <div style={{ display: "flex", justifyContent: "center", paddingTop: 40 }}>
            <Spinner />
          </div>
        ) : repos.length === 0 ? (
          <NonIdealState
            icon="folder-open"
            title="No repos found"
            description="Add sc-queue.md or sc-note.md to a repo to see it here."
          />
        ) : (
          repos.map((repo) => (
            <Link
              key={repo.path}
              to={repo.path}
              style={{ textDecoration: "none", display: "block", marginBottom: 12 }}
            >
              <Card
                interactive
                style={{ display: "flex", alignItems: "center", gap: 12 }}
              >
                <span
                  style={{
                    fontFamily: "var(--bp-typography-family-mono)",
                    fontWeight: 600,
                    flex: 1,
                  }}
                >
                  {repo.name}
                </span>
                <Tag minimal>{workspaceLabel(repo.path)}</Tag>
                {repo.hasQueue && (
                  <Tag intent={Intent.PRIMARY} minimal>
                    queue
                  </Tag>
                )}
                {repo.hasNotes && <Tag minimal>notes</Tag>}
                <Button
                  variant="minimal"
                  icon="trash"
                  intent={Intent.DANGER}
                  small
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDeleteTarget(repo);
                  }}
                />
              </Card>
            </Link>
          ))
        )}
      </div>

      {/* Init repo dialog */}
      <Dialog
        isOpen={initOpen}
        onClose={() => setInitOpen(false)}
        title="Init repo"
        icon="add"
      >
        <DialogBody style={{ padding: "12px 16px 4px" }}>
          <InputGroup
            placeholder="Filter folders…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
            }}
            leftIcon="search"
            autoFocus
            fill
          />
          <Menu
            style={{
              height: 280,
              overflowY: "auto",
              marginTop: 4,
              boxShadow: "none",
              padding: "4px 0",
            }}
          >
            {(() => {
              const filtered = query
                ? candidates.filter((c) =>
                    c.name.toLowerCase().includes(query.toLowerCase()),
                  )
                : candidates;
              if (filtered.length === 0) {
                return <MenuItem disabled text="No folders found" roleStructure="listoption" />;
              }
              return filtered.map((item) => (
                <MenuItem
                  key={`${item.workspace}/${item.name}`}
                  text={item.name}
                  label={item.workspace}
                  active={
                    selected?.name === item.name &&
                    selected.workspace === item.workspace
                  }
                  onClick={() => setSelected(item)}
                  roleStructure="listoption"
                />
              ));
            })()}
          </Menu>
          {initError && (
            <p style={{ color: "var(--bp-intent-danger-color)", margin: "4px 0 0", fontSize: 13 }}>
              {initError}
            </p>
          )}
        </DialogBody>
        <DialogFooter
          actions={
            <>
              <Button onClick={() => setInitOpen(false)}>Cancel</Button>
              <Button
                intent={Intent.PRIMARY}
                loading={initLoading}
                disabled={!selected}
                onClick={() => void handleInit()}
              >
                Create
              </Button>
            </>
          }
        />
      </Dialog>

      {/* Delete confirm alert */}
      <Alert
        isOpen={!!deleteTarget}
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteTarget(null)}
        intent={Intent.DANGER}
        confirmButtonText="Remove"
        cancelButtonText="Cancel"
        loading={deleteLoading}
        icon="trash"
      >
        <p>
          Remove <strong>{deleteTarget?.name}</strong> from sideclaw?
        </p>
        <p style={{ opacity: 0.7, fontSize: 13, marginBottom: 0 }}>
          Deletes sc-queue.md and sc-note.md. The directory itself is not removed.
        </p>
      </Alert>
    </div>
  );
}
