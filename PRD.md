# sideclaw — Product Requirements Document

## Overview

`sideclaw` is a local web dashboard for Claude Code's per-repo AI workflow files:

- **`sc-queue.md`** — the task queue injected into Claude sessions via the Stop hook
- **`sc-note.md`** — freeform session notes alongside each project

It provides a purpose-built UI that understands queue structure (task types, ordering, PAUSE sentinels) and a rich markdown editor for notes — running as a persistent local service in Docker.

---

## Goals

- See and manage the active queue for any local repo without touching the CLI
- Take session notes in a proper editor (EasyMDE) per repo
- File changes from CLI (`cq add`, `cq pop`) or Claude Code are reflected in the UI in near-real-time
- Show local git status (branch, ahead/behind, staged/unstaged) per repo — no GitHub API needed for this
- No backend state — every truth lives in the files; the server is stateless

---

## Non-Goals

- Authentication, multi-user, or any network exposure
- Replacing the `cq` CLI (the CLI remains authoritative for scripting and Stop hook)
- Editing arbitrary markdown files beyond `sc-queue.md` and `sc-note.md`
- A database, ORM, or any persistent server-side state
- GitHub API integration (PRs, CI status, CodeRabbit) — deferred to v1.1, see below

---

## Architecture

### KISS: One Server, One Port

```
┌─────────────────────────────────────┐
│  Docker container (port 7705)       │
│                                     │
│  Bun/Elysia server                  │
│  ├── /api/*        REST + SSE       │
│  └── /*            Vite SPA (built) │
│                                     │
│  Volume: ~/SourceRoot → /repos/personal │
│  Volume: ~/IuRoot    → /repos/work      │
│  Volume: ~/.claude  → /claude       │
└─────────────────────────────────────┘
```

Single `package.json`, no Bun workspace needed. Vite builds the React SPA to `dist/`; Elysia serves it as static files alongside the API. In development, Vite dev server proxies `/api` to Elysia.

### Stack

| Layer | Choice | Reason |
|-|-|-|
| Runtime | Bun | Matches existing cq tooling, fast startup |
| Server | Elysia | Typed, Bun-native, built-in SSE |
| Frontend | React 19 + Vite | BlueprintJS is React-first |
| FE/BE contract | Eden Treaty | Type-safe Elysia client; SSE via `.subscribe()` |
| UI | BlueprintJS v6 | Requested; dark/light, rich components |
| Editor | EasyMDE | Markdown editor for sc-note.md and task expansion |
| Drag & drop | @dnd-kit/sortable | Blueprint has no built-in DnD; wraps BP Cards cleanly |
| Fonts | JetBrains Mono + Geist Sans | Requested |
| Container | Docker Compose | Always-on, file volume access |
| Build | Makefile | Easy ongoing ops |

---

## File System Integration

The container mounts the host filesystem read-write:

```yaml
volumes:
  - ~/SourceRoot:/repos/personal    # personal projects workspace
  - ~/IuRoot:/repos/work            # work projects workspace
  - ~/.claude:/claude                 # queue state dir (for future global views)
```

Paths in the API use the host path prefix. Example:
- URL: `localhost:7705/repos/personal/vps`
- Container resolves to: `/repos/personal/vps/sc-queue.md` and `/repos/personal/vps/sc-note.md`

The server scans for repos by finding all directories under `/repos` (one level deep) that contain either `sc-queue.md` or `sc-note.md`.

---

## Data Model

### `sc-queue.md` Format (unchanged — CLI-compatible)

Tasks separated by `\n---\n`. Block types detected by first line:

```
task text (plain)
---
/slash-command
---
PAUSE
---
Multi-line task
with context
```

Format is pure human-editable markdown. The parser is lenient — malformed blocks fall back to `kind: "task"`. No schema enforcement. CLI and web UI always stay in sync via the shared `parse-queue.ts` module.

### Parsed Task Object

```typescript
interface QueueTask {
  index: number;
  kind: "task" | "slash" | "pause";
  content: string;        // full block text
  preview: string;        // first line
  lineCount: number;
}
```

`parse-queue.ts` lives in `sideclaw/server/lib/` and is used only by the web server. The `cq` CLI (`scripts/queue.ts` in claude-local) remains a separate implementation — sharing the parser module is not worth the coupling given they live in different scopes.

---

## Sync Strategy

### Problem

`sc-queue.md` is modified by three actors concurrently:
1. **`cq` CLI** — user adds/removes tasks
2. **Claude Code Stop hook** — pops tasks on session end
3. **Web UI** — user drags, edits, deletes via browser

### Solution: File Watching + SSE + Last-Write-Wins

```
File change (any actor)
    │
    ▼
Bun fs.watch() on sc-queue.md / sc-note.md
    │
    ▼
SSE event → all connected clients → React re-fetches
    │
    ▼
UI shows fresh state (no stale cache)
```

**Eden Treaty SSE:** The Elysia SSE endpoint is consumed on the client via Eden Treaty's `.subscribe()` method, giving type-safe event handling without raw `EventSource`.

**Write path (web UI):**
1. User action → optimistic UI update
2. `PATCH /api/queue/:repo` with full task array
3. Server serializes to `sc-queue.md` and writes atomically (write to `.sc-queue.md.tmp`, then rename)
4. File watcher fires, SSE broadcasts — other clients sync

**Conflict handling:** Last-write-wins is correct here. This is a single-user local tool. The only real race is Claude Code's Stop hook popping a task while the user is reordering — the SSE sync handles this gracefully (UI resets to actual file state after the write).

**Atomic write temp files** (`.sc-queue.md.tmp`, `.sc-note.md.tmp`) are in the global gitignore — they will never appear as untracked files.

---

## API

```
GET  /api/repos                       List all repos with sc-queue.md or sc-note.md
GET  /api/repo?path=/repos/personal/vps   Parse both files + git status for a repo
GET  /api/queue?path=/repos/personal/vps  Parse sc-queue.md → task array
PUT  /api/queue?path=/repos/personal/vps  Write task array → sc-queue.md
GET  /api/notes?path=/repos/personal/vps  Read sc-note.md raw markdown
PUT  /api/notes?path=/repos/personal/vps  Write sc-note.md
GET  /api/git?path=/repos/personal/vps    Git status (branch, ahead/behind, staged/unstaged)
GET  /api/events?path=/repos/personal/vps SSE stream — emits "change" on file mutation
```

All routes return `{ ok: true, data: ... }` or `{ ok: false, error: string }`.

---

## UI / UX

### Routing

```
/                          Repo list (all repos with sc-queue.md or sc-note.md)
/:encodedPath              Project dashboard for one repo
```

`encodedPath` is the repo's absolute path URL-encoded (e.g. `%2Frepos%2Fpersonal%2Fvps`).

### Project Dashboard

```
┌──────────────────────────────────────────┐
│  Header: repo name + path                │
│  Git: main · ↑3 · +142 −38 · 2 staged   │
│  [theme toggle]  [Refresh]               │
├──────────────────────────────────────────┤
│  QUEUE  [collapse]              [+ Add]  │
│  ┌─────────────────────────────────┐     │
│  │ ⚡ /commit --split         [×] │     │
│  │ ◆ Refactor auth service    [×] │     │
│  │ ⏸ PAUSE                    [×] │     │
│  │ ◆ Write CHANGELOG          [×] │     │
│  └─────────────────────────────────┘     │
│  Drag to reorder · Click to expand+edit  │
├──────────────────────────────────────────┤
│  NOTES  [collapse]                       │
│  ┌─────────────────────────────────┐     │
│  │  EasyMDE editor                 │     │
│  │  (sc-note.md content)            │     │
│  └─────────────────────────────────┘     │
│  Auto-saves after 1s debounce            │
└──────────────────────────────────────────┘
```

### Queue Cards

Each task renders as a BlueprintJS Card:
- **Icon** left: ⚡ (Intent.PRIMARY), ◆ (Intent.NONE), ⏸ (Intent.WARNING)
- **Preview** text: first line of content (JetBrains Mono for slash commands)
- **Expand** button: reveals full multi-line content in an EasyMDE editor — saves on blur/Ctrl+S
- **Delete** button: removes from queue
- **Drag handle**: reorder via @dnd-kit/sortable (SortableContext wrapping BP Cards)

Add task: BlueprintJS InputGroup at bottom of list, Enter to add. Slash commands detected by `/` prefix.

### Git Status Bar

Shown in the project header, populated from `/api/git`:
- Current branch name
- Commits ahead of default branch (↑N)
- Diff stats: insertions/deletions (+N −N)
- Staged file count

Implemented via `git` shell commands run server-side (no GitHub token required).

### Notes Editor

EasyMDE with:
- `spellChecker: false`
- `autosave: { enabled: true, delay: 1000 }`
- BlueprintJS-matched toolbar
- Syncs from SSE (if file changes externally while editor open: show diff banner, let user accept)

### Theme

- Default: system preference via `prefers-color-scheme` → Blueprint's `dark` class toggled on `<body>`
- Manual override toggle in header persisted to `localStorage`
- Geist Sans as default sans-serif (via CSS variable / Blueprint font override)
- JetBrains Mono for code, slash commands, and queue previews

---

## Docker Setup

```
claude-local/sideclaw/
├── Dockerfile
├── docker-compose.yml
├── Makefile
├── package.json
├── vite.config.ts
├── tsconfig.json
├── server/
│   ├── index.ts          Elysia app, static serving, SSE
│   ├── routes/
│   │   ├── repos.ts
│   │   ├── queue.ts
│   │   ├── notes.ts
│   │   └── git.ts
│   └── lib/
│       └── parse-queue.ts  Shared parser (same logic as cq CLI)
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── pages/
    │   ├── RepoList.tsx
    │   └── RepoDashboard.tsx
    └── components/
        ├── QueuePanel.tsx
        ├── QueueCard.tsx
        ├── GitStatusBar.tsx
        └── NotesPanel.tsx
```

### Makefile targets

```makefile
up          docker compose up -d --build
down        docker compose down
rebuild     docker compose up -d --build --force-recreate
logs        docker compose logs -f
shell       docker compose exec sideclaw sh
```

### Environment Configuration

Paths are configured via `.env` (from `../.env` at repo root, not committed):

```env
PERSONAL_REPOS_PATH=/Users/yourname/SourceRoot
WORK_REPOS_PATH=/Users/yourname/IuRoot
CQUEUE_PORT=7705
UID=501
GID=20
```

Two named volume variables is the correct approach — Docker Compose volumes require discrete entries per mount point and cannot loop over a comma-separated list. Adding a third workspace later means adding one variable.

`docker-compose.yml` reads these:

```yaml
services:
  sideclaw:
    build: .
    ports:
      - "${CQUEUE_PORT:-7705}:7705"
    volumes:
      - ${PERSONAL_REPOS_PATH}:/repos/personal:rw
      - ${WORK_REPOS_PATH}:/repos/work:rw
    user: "${UID}:${GID}"
    restart: unless-stopped
```

### Key Docker details

- **Dual volume mounts**: both `~/SourceRoot` and `~/IuRoot` are mounted under `/repos/`, making repos from both workspaces visible at `/repos/personal/*` and `/repos/work/*`
- **Host UID**: `user: "${UID}:${GID}"` ensures file writes have correct ownership — no permission issues when `cq` CLI or Claude Code reads the same files afterward
- **Makefile delegates to root `.env`**: `cd sideclaw && docker compose --env-file ../.env up`
- **Git commands**: the server runs `git` inside the container; the `.git/` directory is accessible via the volume mount

---

## File Creation Behavior

When a repo directory is accessed that has neither `sc-queue.md` nor `sc-note.md`, the server creates empty files on first access so the UI always has something to work with. This mirrors `cq`'s behavior of writing the queue file on first `cq add`.

---

## Future: GitHub Integration (v1.1)

Deferred from MVP. Requires `GITHUB_TOKEN` in `.env`.

Planned additions:
- Open PR count + per-PR status (CI passing/failing/pending, CodeRabbit approved/pending)
- PR list view per repo with quick links
- New API route: `GET /api/github?path=...` returning PR/CI state

Local git status (branch, ahead/behind, staged counts) is MVP and requires no token.

---

## Open Questions

1. **Recursive repo discovery** — scan one level under `/repos` or deeper? Start with one level (direct children of each workspace root), add depth later.
2. **Notes conflict on external edit** — banner with "File changed externally — reload?" is sufficient. No true merge needed (single user).
