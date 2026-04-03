# Group 2: Server Core — Parser, Repos, Git

## What You're Doing

Implement the server foundation: the `parse-queue.ts` library, the `/api/repos` discovery route, the `/api/git` route for local git status, and the `/api/repo` combined route. No queue write endpoints yet — read-only server that can discover repos and report git state.

---

## Research & Exploration First

1. Read `sideclaw/PRD.md` — API section and File System Integration
2. Read `sideclaw/server/index.ts` from Group 1 — understand the current stub
3. Research Elysia routing and query parameter handling via Context7
4. Check Bun's `Bun.spawnSync` or `execa`-equivalent for running `git` shell commands
5. Review Bun's `fs` module for directory scanning (`fs.readdirSync` / `Bun.file`)

---

## What to Implement

### 1. `server/lib/parse-queue.ts`

The queue parser — used only by the web server (not shared with `cq` CLI).

```typescript
export interface QueueTask {
  index: number;
  kind: "task" | "slash" | "pause";
  content: string;    // full block text (trimmed)
  preview: string;    // first line
  lineCount: number;
}

export function parseQueue(raw: string): QueueTask[]
export function serializeQueue(tasks: QueueTask[]): string
```

Parser rules:
- Split on `\n---\n`
- Trim each block
- Empty blocks: skip
- First line is `PAUSE` (case-insensitive) → `kind: "pause"`
- First line starts with `/` → `kind: "slash"`
- Otherwise → `kind: "task"`
- `preview` = first line, `lineCount` = block.split('\n').length
- Assign sequential `index` starting at 0

Serializer: join tasks by `\n---\n`, no trailing separator.

### 2. `server/lib/repo-scanner.ts`

```typescript
export interface RepoInfo {
  name: string;         // directory name
  path: string;         // absolute container path e.g. /repos/SourceRoot/vps
  hasQueue: boolean;
  hasNotes: boolean;
}

export function scanRepos(): RepoInfo[]
```

Logic:
- Read directories under `/repos/SourceRoot` and `/repos/IuRoot` (one level deep)
- For each: check if `sc-queue.md` or `sc-note.md` exists
- Include only dirs with at least one of the two files
- Handle missing workspace dirs gracefully (not all may be mounted)

### 3. `server/lib/git.ts`

```typescript
export interface GitStatus {
  branch: string;
  ahead: number;        // commits ahead of default branch
  behind: number;       // commits behind (usually 0 for local tool)
  insertions: number;   // from git diff --shortstat
  deletions: number;
  stagedCount: number;  // files in index
}

export function getGitStatus(repoPath: string): GitStatus | null
```

Implementation via `git` shell commands (use `Bun.spawnSync`):
- `git -C <path> rev-parse --abbrev-ref HEAD` → branch name
- `git -C <path> rev-list --left-right --count HEAD...@{upstream}` → ahead/behind (handle no upstream gracefully)
- `git -C <path> diff --shortstat` → insertions/deletions
- `git -C <path> diff --cached --name-only` → staged count
- Return `null` if not a git repo or git not available

### 4. `server/routes/repos.ts`

```typescript
// GET /api/repos → { ok: true, data: RepoInfo[] }
// GET /api/repo?path=/repos/SourceRoot/vps → { ok: true, data: { repo, queue, notes, git } }
//   where queue = QueueTask[], notes = string (raw), git = GitStatus | null
```

For `/api/repo`: if `sc-queue.md` doesn't exist, create an empty one. Same for `sc-note.md`. This mirrors `cq`'s behavior.

### 5. Wire routes into `server/index.ts`

```typescript
import { Elysia } from 'elysia'
import { staticPlugin } from '@elysiajs/static'
import { reposRoutes } from './routes/repos'

const app = new Elysia()
  .use(reposRoutes)
  .use(staticPlugin({ assets: 'dist', prefix: '/' }))
  .listen(7705)
```

Serve static files from `dist/` (built SPA). In development the Vite proxy handles the SPA.

---

## Validation

```bash
bun run typecheck   # must pass
bun run build       # must pass
```

Manual smoke test (optional — only if Docker is running):
```bash
curl http://localhost:7705/api/repos
```

---

## Commit

```
feat(sideclaw): add queue parser, repo scanner, and git status server routes
```

---

## Done

Append learning notes to `docs/ralph/RALPH_NOTES.md`, then:
```
RALPH_TASK_COMPLETE: Group 2
```
