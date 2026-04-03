# Group 6: Notes Editor, SSE Polish & Final Integration

## What You're Doing

Complete the app: `NotesPanel` with EasyMDE editor, SSE-driven live sync for notes (with external-change banner), theme toggle in the header, and any remaining integration gaps. After this group the app is fully functional and ready for Docker testing.

---

## Research & Exploration First

1. Read all existing `sideclaw/src/` files — understand the current state
2. Read `docs/ralph/RALPH_NOTES.md` — all previous group notes
3. Research EasyMDE via Context7 or WebFetch its README — init options, controlled vs uncontrolled, `value()`, `codemirror` events
4. Research BlueprintJS v6 `Callout` / `Alert` for the external-change banner
5. Check if EasyMDE has TypeScript types (`@types/easymde`) or ships its own

---

## What to Implement

### 1. `src/components/NotesPanel.tsx`

```typescript
interface Props {
  notes: string;        // initial content from API
  repoPath: string;
  externallyChanged: boolean;
  onExternalChangeAck: () => void;
}
```

EasyMDE setup:
```typescript
// options:
// spellChecker: false
// autosave: { enabled: false }   // we handle save ourselves
// toolbar: standard MD toolbar (bold, italic, heading, link, image, code, preview, side-by-side, fullscreen)
// placeholder: "Session notes..."
```

Auto-save after 1s debounce:
- On editor change → start 1s timer
- Timer fires → `PUT /api/notes` with current content
- Cancel timer on external change or unmount

External change handling (SSE fires "change" for notes file while editor is open):
- Set `externallyChanged = true`
- Show a Blueprint `Callout` banner: "Notes changed externally — [Reload]"
- On Reload: re-fetch notes, reinitialize EasyMDE with new content, clear banner

Section header: "NOTES" label + collapse toggle (same pattern as QueuePanel).

### 2. Theme toggle in header

In `RepoDashboard.tsx` header area:
- Blueprint `Button` with sun/moon icon
- Uses `ThemeContext.toggle()` from Group 4
- Persists to `localStorage`

### 3. SSE integration completeness

Audit `RepoDashboard.tsx`:
- Single SSE connection (`/api/events?path=...`) per dashboard view
- On event `{ file: "queue" }`: re-fetch queue (skip if user is actively dragging)
- On event `{ file: "notes" }`: set `externallyChanged` flag on NotesPanel
- Clean up SSE on component unmount
- Handle SSE connection errors: show a subtle `<Tag intent="danger">Disconnected</Tag>` and retry after 5s

### 4. Repo list header

In `RepoList.tsx`, add:
- Page title "sideclaw" in Blueprint `Navbar` (Geist Sans, large)
- Theme toggle button (same as dashboard)
- Subtitle: "Claude Code task queue dashboard"

### 5. Error boundaries

Wrap `RepoDashboard` in a React error boundary that renders a Blueprint `NonIdealState` with error details if the dashboard crashes. Keep it simple — no external library needed.

### 6. Final Dockerfile polish

Ensure the Dockerfile copies all necessary files and the `bun start` command works. The server should serve `dist/index.html` for all non-`/api` routes (SPA fallback).

In `server/index.ts`:
```typescript
// After all API routes, add SPA fallback:
.get('*', ({ set }) => {
  set.headers['content-type'] = 'text/html'
  return Bun.file('dist/index.html')
})
```

---

## Validation

```bash
bun run typecheck   # must pass — including EasyMDE types
bun run build       # must produce dist/
docker build -t sideclaw-test . && docker rmi sideclaw-test   # image must build
```

---

## Commit

```
feat(sideclaw): add notes editor, SSE polish, theme toggle — complete MVP
```

---

## Done

Append learning notes to `docs/ralph/RALPH_NOTES.md`, then:
```
RALPH_TASK_COMPLETE: Group 6
```
