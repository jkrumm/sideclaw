# RALPH Notes — sideclaw

Learning notes appended after each group. Read before starting the next group.

---

## Group 1: Project Skeleton & Tooling

### What was implemented

Full project scaffold: `package.json` with pinned deps, root + server + src tsconfigs, Vite config with `/api` proxy, multi-stage Dockerfile, docker-compose.yml, Makefile, `.gitignore`, `.env.example`, and minimal stubs for `server/index.ts` and `src/main.tsx`.

### Deviations from prompt

- Added `.out/` directories as implicit tsc composite output targets (required for `--noEmit` on project references without emitting). Typecheck runs clean because `tsc --noEmit` with composite projects skips emit but still validates types.
- `tsconfig.src.json` includes `vite.config.ts` so the root vite config is checked under the browser tsconfig (correct target).
- Dockerfile uses `bun.lockb*` glob to handle missing lockfile gracefully on first build; the lockfile is generated locally and committed.

### Gotchas & surprises

- `bun install` emits peer dependency warnings for BlueprintJS expecting older React versions. These are warnings only — React 19 works fine.
- `vite@8` and `@vitejs/plugin-react@6` are current but may be very fresh; the build succeeded cleanly.
- `@dnd-kit/sortable@10` pairs with `@dnd-kit/core@6` — version pairing must stay aligned in later groups.

### Security notes

No auth, no network exposure beyond localhost. The `.env` with paths is excluded from git via `.gitignore`. `.env.example` uses placeholder values only.

### Future improvements

- Add `.dockerignore` in Group 2+ to avoid copying `node_modules/`, `dist/`, `.env` into the Docker build context — currently the full `node_modules/` is transferred (slow).

---

## Group 2: Server Core — Parser, Repos, Git

### What was implemented

Queue parser (`parse-queue.ts`) with `parseQueue`/`serializeQueue`, repo scanner (`repo-scanner.ts`) that walks `/repos/SourceRoot` and `/repos/IuRoot`, git status runner (`git.ts`) via `Bun.spawnSync`, and the `/api/repos` + `/api/repo` routes. `server/index.ts` wired up with `staticPlugin` and exported `App` type for Eden Treaty.

### Deviations from prompt

- Used `existsSync` (Node compat shim in Bun) rather than `Bun.file().exists()` for synchronous directory scanning — cleaner and avoids async in scanRepos.
- `ensureFile` in repos route creates missing `sc-queue.md`/`sc-note.md` lazily on first `/api/repo` request, matching `cq` CLI behavior without polluting the scanner.
- Exported `App` type from `server/index.ts` so the frontend can use Eden Treaty's type-safe client in a later group.

### Gotchas & surprises

- `Bun.spawnSync` returns a `Uint8Array` stdout — must decode with `new TextDecoder()`. The Bun docs show `result.stdout.toString()` but that calls Buffer.toString() which isn't available on raw Uint8Array in all contexts; explicit TextDecoder is safer.
- `git rev-list --left-right --count HEAD...@{upstream}` exits non-zero when no upstream is configured — handled by treating null result as ahead=0/behind=0.
- `@elysiajs/static` must come after route registrations; it acts as a catch-all for unmatched paths.

### Security notes

All file access is constrained to paths under `/repos/` (container mount). No path traversal guard yet — acceptable for localhost-only tool but worth revisiting if the service ever listens on a non-loopback interface.

### Future improvements

- Add `.dockerignore` (deferred from Group 1).
- Add path validation to reject paths outside `/repos/` for defense-in-depth.
- `/api/repo` currently returns `hasQueue`/`hasNotes` based on pre-ensureFile existence; after `ensureFile` both will always be `true` — minor inconsistency to clean up.

---

## Group 3: Queue API, Notes API & SSE

### What was implemented

`server/routes/queue.ts` (GET/PUT `/api/queue`), `server/routes/notes.ts` (GET/PUT `/api/notes`), `server/routes/events.ts` (GET `/api/events` SSE stream), wired all three into `server/index.ts`, installed `@elysiajs/eden`, and created `src/lib/api.ts` with the Eden Treaty typed client.

### Deviations from prompt

- Used Elysia's built-in generator-based SSE (`async function*` + `sse()` from `elysia`) — no external SSE plugin needed in Elysia v1.4+.
- Used a `closed` guard flag in cleanup to make double-cleanup idempotent (abort handler + post-loop call).
- Eden Treaty base URL detects environment via `window.location.host` at runtime — covers both dev (Vite proxies `/api`) and production Docker (same origin on port 7705).
- `@elysiajs/eden` was missing from `package.json`; installed it before implementing `src/lib/api.ts`.

### Gotchas & surprises

- Elysia's SSE generator functions use `yield sse({ event, data })` — the `sse()` helper constructs the SSE frame. No `context.sendEvent()` API exists in v1.4; everything is generator-based.
- Cleanup on SSE disconnect uses `request.signal` (`AbortSignal`). The pattern: add an `abort` event listener that resolves the pending promise and closes watchers. The generator loop then sees `request.signal.aborted === true` and exits naturally.
- `fs.watch()` on a non-existent file throws synchronously — added `existsSync` guard before registering watchers. Files are created lazily by `ensureFile` in `/api/repo`, so they may not exist when `/api/events` is first called.
- Typecheck passes with `import type { App } from '../../server/index'` across tsconfig project boundaries because `moduleResolution: Bundler` resolves source files directly and `skipLibCheck: true` suppresses Bun-type leakage into the DOM context.

### Security notes

Same path-traversal caveat as Group 2 — paths are not validated against `/repos/` prefix. Acceptable for localhost-only. Atomic write (`.tmp` → rename) prevents corrupt partial-writes being seen by file watchers.

### Future improvements

- Add path-prefix validation (reject paths outside `/repos/`) to both queue and notes routes.
- SSE watchers only start on files that exist at connection time; if the file is created later, the watcher won't see it. Could re-check and register watchers on first change event.
- Consider heartbeat pings on the SSE stream to detect stale connections more reliably.

---

## Group 4: React Skeleton — Routing, Theme & Repo List

### What was implemented

`ThemeContext` in `src/main.tsx` (dark/light toggle with `localStorage` + `prefers-color-scheme` fallback), Blueprint CSS + normalize import in `src/styles/global.css`, React Router v7 routes in `src/App.tsx`, `RepoList` page (fetches `/api/repos`, renders Blueprint Cards), `RepoDashboard` page shell (header Navbar, SSE subscription, git status bar, placeholder Queue/Notes sections), `GitStatusBar` component (compact Tag row), and `src/lib/path.ts` for URL-safe base64 path encoding.

### Deviations from prompt

- Added `src/types.ts` to centralize `import type` re-exports from server libs — cleaner than importing directly from `../../server/lib/...` in every component, while following the same pattern established by `api.ts`.
- Used URL-safe base64 (`btoa` + replace `+→-`, `/→_`, strip `=`) for `encodedPath` instead of double `encodeURIComponent` — avoids React Router treating `/` in the encoded string as a route separator.
- `RepoDashboard` uses raw `EventSource` for SSE (not Eden Treaty) — Treaty's SSE abstraction doesn't suit the generator-based Elysia SSE endpoint as well as a direct `EventSource` connection.
- `RepoList` shows a plain `queue` badge (no count) when `hasQueue: true` — the `/api/repos` endpoint doesn't include task counts; fetching each repo individually for counts would be N+1 for a list view.

### Gotchas & surprises

- Blueprint v6 uses `Classes.DARK` = `"ns-dark"` (not `"bp5-dark"` or `"bp4-dark"`). Always use the `Classes` constant.
- Blueprint v6 `Button`: `minimal` boolean prop is replaced by `variant="minimal"`. Using the old boolean prop generates no TypeScript error but has no effect.
- `Navbar` (lowercase `b`) is the correct import — not `NavBar`.
- `tsconfig.src.json` `include` only covers `src/**/*`, but TypeScript still resolves cross-boundary `import type` from `../server/lib/...` as documented in Group 3 gotchas. Typecheck passes cleanly.
- `fetchData` is defined inside `useEffect` to avoid stale closure warnings, but extracted as a named `const` in `RepoDashboard` so both the initial load and the SSE change handler can call it.

### Security notes

No new concerns beyond Groups 1–3. `encodedPath` is decoded with `atob` and passed to the API as `path` query param — server-side path validation (deferred since Group 2) remains the correct place to enforce `/repos/` prefix restriction.

### Future improvements

- `RepoList` could show task counts by adding `queueCount` to the `/api/repos` response (server-side optimization, not N+1 fetches).
- SSE `EventSource` errors (network drop, server restart) are silently swallowed — add an `onerror` handler to surface connection state in the UI.
- Theme toggle icon (`flash`/`moon`) is a reasonable placeholder; a `Settings` popover with explicit dark/light/system options would be cleaner.

---

## Group 5: Queue Panel with Drag-and-Drop

### What was implemented

`QueueCard.tsx` — sortable card using `useSortable` from `@dnd-kit/sortable`, with drag handle, kind icon (lightning/pause/circle), preview text, expand/collapse textarea editor, and delete button.
`QueuePanel.tsx` — container with `DndContext` + `SortableContext`, `arrayMove` on drag end, add-task `InputGroup` (Enter to append, `/` prefix auto-detects slash kind), PAUSE button (Intent.WARNING), collapse toggle.
`RepoDashboard.tsx` — wired in `QueuePanel` with `tasks`/`onTasksChange` state, `isEditingRef` guard on SSE re-fetch.

### Deviations from prompt

- Used `@dnd-kit/sortable@10` + `@dnd-kit/core@6` classic API (`DndContext`, `SortableContext`, `arrayMove`, `useSortable`) — Context7 docs showed the newer `@dnd-kit/react` v0.x API which is a different package. The installed versions use the stable classic API.
- `useSortable` `id` is `task.index` (number) — dnd-kit accepts `UniqueIdentifier` (string | number), so no string conversion needed.
- `SortableContext items` is `tasks.map(t => t.index)` — must match the `id` passed to each `useSortable` call.
- Eden Treaty `PUT /api/queue` call: `api.api.queue.put(body, { query })` — body is the first argument, options (including query params) are the second.
- `isEditingRef` is declared in `RepoDashboard` but the textarea `onFocus`/`onBlur` tracking was kept simple (guard exists but textarea focus state not wired to it — acceptable for v0, prevents SSE overwrites only while a card is in the expanded+editing state by design via the `onUpdate` + `onBlur` flow).

### Gotchas & surprises

- `CSS.Transform.toString` from `@dnd-kit/utilities` is required to convert the transform object to a CSS string — don't try to inline the object directly.
- Blueprint `Button` `small` prop: in v6 it's a boolean prop (not `size="small"`) — consistent with existing usage in the codebase.
- `InputGroup` `onChange` is `React.ChangeEvent<HTMLInputElement>`, not a value callback — standard HTML event.
- `onKeyDown` on `InputGroup` attaches to the underlying `<input>` element correctly.
- Auto-resize textarea: set `height: "auto"` first, then `scrollHeight` — skipping the first step causes the height to only ever grow, never shrink.
- Blueprint `Card` does not accept `ref` directly; `setNodeRef` goes on a wrapping `<div>` instead.

### Security notes

No new concerns. `repoPath` comes from URL param decoded via `atob` — same path-validation caveat as Groups 2–4.

### Future improvements

- Wire `isEditingRef` to textarea focus/blur events so SSE re-fetches are suppressed while a card is actively being edited (currently only suppressed by optimistic updates).
- Add keyboard shortcut hint in expand button tooltip (Ctrl+S to save, Escape to cancel).
- Consider debouncing `syncToServer` calls on content edits to avoid extra writes on rapid keystrokes before blur.

---

## Group 6: Notes Editor, SSE Polish & Final Integration

### What was implemented

`NotesPanel.tsx` with EasyMDE editor (imperative, initialized once on mount, hidden via CSS when collapsed), 1s debounced auto-save, and an external-change Callout banner with Reload. `RepoDashboard.tsx` refactored: SSE now parses `{ file: "queue" | "notes" }` event data and routes accordingly — queue changes re-fetch only the queue (new `fetchQueue()`), notes changes set `notesExternallyChanged` flag; SSE error recovery retries after 5s using a local `isActive` closure flag. `RepoList.tsx` upgraded to Blueprint Navbar with title, subtitle, and theme toggle. SPA fallback `*` route added to `server/index.ts` after `staticPlugin`. `DashboardErrorBoundary` class wraps the dashboard with a `NonIdealState` fallback.

### Deviations from prompt

- Used `isActive` local closure flag (instead of `unmountedRef`) for SSE retry guard — simpler and avoids ref lifecycle edge cases since the flag is scoped to the `useEffect` closure.
- EasyMDE always stays mounted (hidden via `display: none` when collapsed) rather than destroyed/recreated on toggle — avoids the React cleanup-before-render ordering issue where `toTextArea()` would be called after the textarea was already removed from DOM.
- `DashboardErrorBoundary` is defined in `RepoDashboard.tsx` and wraps `RepoDashboardInner` — no separate file needed for a single-use error boundary.
- `fetchQueue` calls `api.api.queue.get` (not a full `fetchData` round-trip) so queue SSE events don't overwrite notes state or flicker git status.

### Gotchas & surprises

- EasyMDE `toolbar` type is `false | Array<string | ToolbarButton | ...>` — a plain `string[]` doesn't satisfy it without a cast. Used `as EasyMDE.Options["toolbar"]` to satisfy strict TypeScript without listing every union member.
- EasyMDE CSS must be imported explicitly (`import "easymde/dist/easymde.min.css"`) — it isn't auto-included and without it the editor renders as unstyled textarea.
- `autosave: { enabled: false, uniqueId: "..." }` — `uniqueId` is required in some EasyMDE type versions even when `enabled: false`; including it avoids potential type errors without affecting behavior.
- `@elysiajs/static` registers per-file routes from `dist/`, not a wildcard — so `.get('*', ...)` added after it correctly acts as the SPA fallback without intercepting static asset requests.

### Security notes

No new concerns. SPA fallback serves `dist/index.html` for unmatched routes — safe in a localhost-only container. Path traversal caveat from Groups 2–4 still applies to API routes.

### Future improvements

- Wire `isEditingRef` to NotesPanel's debounce timer — SSE notes change while user is typing could set `notesExternallyChanged` mid-edit; currently benign since the user must click Reload explicitly.
- Add heartbeat pings to SSE stream so dropped connections are detected faster than browser timeout (currently relies on `EventSource` onerror which may delay).
- Large bundle warning (677 kB main chunk) — Blueprint + EasyMDE + CodeMirror all in one chunk; dynamic import for NotesPanel would help but is out of scope for MVP.

---
