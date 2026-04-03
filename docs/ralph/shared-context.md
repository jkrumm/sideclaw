# sideclaw — RALPH Shared Context

You are implementing: **sideclaw**, a local web dashboard for Claude Code's per-repo AI workflow files (`sc-queue.md` and `sc-note.md`).

Read this fully before starting your group. The PRD is the authoritative spec: `sideclaw/PRD.md`.

---

## What sideclaw Is

sideclaw is a persistent local service (Docker, port 7705) that provides a purpose-built browser UI for managing the Claude Code task queue and session notes for any local repo. The queue (`sc-queue.md`) is a plain markdown file consumed by the Claude Code Stop hook. The notes (`sc-note.md`) are freeform session notes alongside each project.

Key invariants:
- **No backend state** — every truth lives in the files; the server is stateless
- **CLI compatibility** — `sc-queue.md` format must not change (tasks separated by `\n---\n`)
- **Single-user local tool** — last-write-wins is correct for conflict handling
- **Authentication-free** — runs only on localhost

---

## Repository Layout

```
sideclaw/
├── PRD.md                  Authoritative product spec — read this
├── Dockerfile
├── docker-compose.yml
├── Makefile
├── package.json            Single package — no workspace
├── vite.config.ts
├── tsconfig.json
├── .env.example
├── scripts/
│   ├── ralph.sh
│   └── ralph-reset.sh
├── docs/ralph/
│   ├── shared-context.md   (this file)
│   ├── RALPH_NOTES.md
│   ├── RALPH_REPORT.md
│   └── prompts/
├── server/
│   ├── index.ts            Elysia app entry
│   ├── routes/
│   │   ├── repos.ts
│   │   ├── queue.ts
│   │   ├── notes.ts
│   │   └── git.ts
│   └── lib/
│       └── parse-queue.ts  Queue parser
└── src/                    React SPA
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

---

## Tech Stack

| Concern | Choice |
|-|-|
| Runtime | Bun |
| Server | Elysia (Bun-native, built-in SSE) |
| Frontend | React 19 + Vite |
| FE/BE contract | Eden Treaty (type-safe Elysia client) |
| UI | BlueprintJS v6 |
| Editor | EasyMDE (markdown editor for cnotes) |
| Drag & drop | @dnd-kit/sortable |
| Fonts | JetBrains Mono + Geist Sans |
| Container | Docker Compose |
| Build | Makefile |

---

## Data Model

### `sc-queue.md` format

Tasks separated by `\n---\n`. Block types detected by first line:
- Plain text → `kind: "task"` (icon: ◆)
- Starts with `/` → `kind: "slash"` (icon: ⚡)
- Equals `PAUSE` → `kind: "pause"` (icon: ⏸)

```typescript
interface QueueTask {
  index: number;
  kind: "task" | "slash" | "pause";
  content: string;   // full block text
  preview: string;   // first line
  lineCount: number;
}
```

---

## API Routes

```
GET  /api/repos                          List all repos
GET  /api/repo?path=/repos/SourceRoot/x  Parse both files + git status
GET  /api/queue?path=...                 Parse sc-queue.md → task array
PUT  /api/queue?path=...                 Write task array → sc-queue.md
GET  /api/notes?path=...                 Read sc-note.md raw
PUT  /api/notes?path=...                 Write sc-note.md
GET  /api/git?path=...                   Git status (branch, ahead/behind, diffs)
GET  /api/events?path=...                SSE stream — emits "change" on file mutation
```

All routes return `{ ok: true, data: ... }` or `{ ok: false, error: string }`.

---

## Sync Strategy

File watching via Bun's `fs.watch()` → SSE broadcast → React re-fetches.
Write path: optimistic UI → `PUT /api/queue` → atomic write (`.tmp` rename) → watcher fires → SSE → clients sync.
Atomic write: write to `.sc-queue.md.tmp`, then `fs.rename()`. Both `.tmp` files are in the global gitignore.

---

## Docker & Environment

```yaml
# docker-compose.yml volumes
- ${SOURCEROOT_PATH}:/repos/SourceRoot:rw
- ${IUROOT_PATH}:/repos/IuRoot:rw
```

`.env` (from `../.env`, not committed):
```
SOURCEROOT_PATH=/Users/yourname/SourceRoot
IUROOT_PATH=/Users/yourname/IuRoot
CQUEUE_PORT=7705
UID=501
GID=20
```

`user: "${UID}:${GID}"` ensures file writes have correct host ownership.

---

## Validation Commands

**Primary (run after every group from inside `sideclaw/`):**
```bash
bun run typecheck   # tsc --noEmit — must be clean
bun run build       # vite build — must produce dist/
```

**Docker (group 1 only, to verify the image builds):**
```bash
docker build -t sideclaw-test . && docker rmi sideclaw-test
```

No automated tests yet — validation is build + typecheck. Manual browser testing happens after Docker is up.

---

## Research Before Implementing

Always start each group by:
1. Reading the PRD: `sideclaw/PRD.md`
2. Reading files already written in previous groups (Glob/Read)
3. Research unfamiliar libraries via Context7 (`@elysia/sse`, Eden Treaty, @dnd-kit/sortable, BlueprintJS v6, EasyMDE)
4. Check Bun's `fs.watch()` API docs if implementing file watching
5. The group prompt is direction — use a better approach if you find one

---

## Learning Notes

After completing each group, **always append** to `docs/ralph/RALPH_NOTES.md`:

```markdown
## Group N: <title>

### What was implemented
<1–3 sentences>

### Deviations from prompt
<what you changed and why>

### Gotchas & surprises
<unexpected library API, quirks, tooling surprises>

### Security notes
<security-relevant decisions>

### Future improvements
<deferred work, tech debt>
```

---

## Commit Format

Conventional commits, no AI attribution:
```
feat(sideclaw): <description>
```

Stage only modified files. Commit before signaling completion.

---

## Completion Signal

Output exactly one of these as the very last line:

```
RALPH_TASK_COMPLETE: Group N
```

If you cannot proceed due to an unresolvable blocker:

```
RALPH_TASK_BLOCKED: Group N - <reason in one sentence>
```
