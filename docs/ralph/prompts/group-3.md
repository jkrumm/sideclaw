# Group 3: Queue API, Notes API & SSE

## What You're Doing

Implement the remaining API routes: queue read/write (`GET`/`PUT /api/queue`), notes read/write (`GET`/`PUT /api/notes`), and the SSE endpoint (`GET /api/events`). After this group the entire backend is complete — a React client could talk to it fully.

---

## Research & Exploration First

1. Read existing server files from Groups 1–2 (Glob `sideclaw/server/**/*.ts`)
2. Research Elysia SSE API via Context7 — specifically `context.sendEvent` or the stream/SSE plugin
3. Check Bun's `fs.watch()` API — it differs from Node's `fs.watch`
4. Read `sideclaw/PRD.md` — Sync Strategy section for atomic write semantics
5. Research Eden Treaty v2 type inference via Context7 — understand how the app type is exported so the client can use it

---

## What to Implement

### 1. `server/routes/queue.ts`

```typescript
// GET /api/queue?path=... → { ok: true, data: QueueTask[] }
// PUT /api/queue?path=... body: { tasks: QueueTask[] } → { ok: true }
```

GET: read `<path>/sc-queue.md`, parse with `parseQueue()`, return array.
PUT: validate body, `serializeQueue(tasks)`, write atomically:
```typescript
await Bun.write(`${queuePath}.tmp`, serialized)
await fs.promises.rename(`${queuePath}.tmp`, queuePath)
```

### 2. `server/routes/notes.ts`

```typescript
// GET /api/notes?path=... → { ok: true, data: string }  (raw markdown)
// PUT /api/notes?path=... body: { content: string } → { ok: true }
```

Same atomic write pattern for PUT.

### 3. SSE in `server/routes/events.ts`

The SSE endpoint watches both `sc-queue.md` and `sc-note.md` for a given repo path:

```typescript
// GET /api/events?path=... → SSE stream
// Event: { type: "change", file: "queue" | "notes" }
```

Use Bun's `fs.watch()`. Clean up watchers when the SSE connection closes (use `onAbort` / request signal).

Implementation sketch:
```typescript
// Elysia SSE — research exact Elysia SSE API via Context7
// Watch both files; on change, send event; on close, stop watchers
```

**Important:** File watchers must be cleaned up on client disconnect to avoid leaks. Test this carefully.

### 4. Export the Elysia app type from `server/index.ts`

```typescript
export type App = typeof app
```

This allows Eden Treaty on the client to consume fully typed routes.

### 5. Create `src/lib/api.ts`

Set up Eden Treaty client:
```typescript
import { treaty } from '@elysiajs/eden'
import type { App } from '../../server/index'

export const api = treaty<App>('localhost:7705')
```

In Docker, the client hits `window.location.host` (same origin). In dev, Vite proxies `/api` to `localhost:7705`. The treaty client should use a relative base or detect environment.

---

## Validation

```bash
bun run typecheck   # must pass — including the Eden Treaty client type
bun run build       # must pass
```

---

## Commit

```
feat(sideclaw): add queue/notes API routes and SSE file-watch endpoint
```

---

## Done

Append learning notes to `docs/ralph/RALPH_NOTES.md`, then:
```
RALPH_TASK_COMPLETE: Group 3
```
