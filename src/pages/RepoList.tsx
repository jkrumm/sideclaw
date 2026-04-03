import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Alignment,
  Button,
  Card,
  Intent,
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

function workspaceLabel(path: string): string {
  return path.split("/").filter(Boolean)[0] ?? "unknown";
}

export function RepoList() {
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const { mode, toggle } = useTheme();

  useEffect(() => {
    api.api.repos
      .get()
      .then(({ data, error }) => {
        if (error) {
          setFetchError(String(error));
          return;
        }
        if (data && data.ok) {
          setRepos(data.data);
        }
      })
      .catch((err: unknown) => setFetchError(String(err)));
  }, []);

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
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
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
              </Card>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
