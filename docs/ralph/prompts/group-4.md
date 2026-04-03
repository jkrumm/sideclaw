# Group 4: React Skeleton — Routing, Theme & Repo List

## What You're Doing

Build the React SPA foundation: theme setup (Blueprint dark/light + JetBrains Mono/Geist Sans fonts), React Router routing, the `RepoList` page, the `RepoDashboard` page shell (header + git status bar + empty panels), and the `GitStatusBar` component. The app should be navigable and render real data from the API.

---

## Research & Exploration First

1. Read all existing files: `sideclaw/src/` and `sideclaw/server/` (Glob)
2. Read the Group 3 notes in `docs/ralph/RALPH_NOTES.md` — check for any API deviations
3. Research BlueprintJS v6 theming via Context7 — dark mode, `Classes.DARK`, and CSS variable approach
4. Research BlueprintJS v6 component APIs: `Card`, `Tag`, `Button`, `NavBar`/`Navbar`, `NonIdealState`, `Spinner`
5. Check how to load JetBrains Mono + Geist Sans (Google Fonts CDN vs. local — prefer CSS @import)

---

## What to Implement

### 1. `src/main.tsx` — Theme provider

Replace stub. Initialize Blueprint theme from `localStorage` + `prefers-color-scheme`:
```typescript
// On mount: check localStorage 'theme' key ('dark'|'light'|null)
// Fallback: window.matchMedia('(prefers-color-scheme: dark)')
// Apply: document.body.classList.toggle('bp5-dark', isDark)
```

Expose a `ThemeContext` with `{ isDark, toggle }` so any component can toggle theme.

### 2. `src/styles/global.css`

Import Blueprint CSS, normalize.css. Set font variables:
```css
@import "@blueprintjs/core/lib/css/blueprint.css";
@import "normalize.css/normalize.css";

:root {
  --font-sans: 'Geist Sans', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}

body {
  font-family: var(--font-sans);
}
```

### 3. `src/App.tsx`

React Router v7 setup:
```typescript
// Routes:
// / → <RepoList />
// /:encodedPath → <RepoDashboard />
```

### 4. `src/pages/RepoList.tsx`

- Fetch `/api/repos` on mount
- BlueprintJS `Card` list — one card per repo
- Card shows: repo name (bold), workspace label (SourceRoot / IuRoot), badge for queue count (if >0), badge "notes" (if sc-note.md exists)
- Click → navigate to `/:encodedPath`
- Loading state: `<Spinner />`
- Empty state: `<NonIdealState title="No repos found" />`

### 5. `src/pages/RepoDashboard.tsx` (shell only)

- Decode `encodedPath` from URL params
- Fetch `/api/repo?path=...` on mount
- Render header (repo name + full path) + `<GitStatusBar>` + placeholder sections for Queue and Notes
- Subscribe to SSE (`/api/events?path=...`) — on "change" event, re-fetch repo data

### 6. `src/components/GitStatusBar.tsx`

```typescript
interface Props { git: GitStatus | null; repoName: string }
```

Renders as a compact Blueprint `Tag` row inside the dashboard header:
- Branch name (Tag, monospace)
- `↑{ahead}` if ahead > 0 (Tag, intent PRIMARY)
- `+{insertions} −{deletions}` if non-zero (Tag, intent SUCCESS / DANGER)
- `{stagedCount} staged` if staged > 0 (Tag, intent WARNING)
- Nothing if `git` is null

---

## Validation

```bash
bun run typecheck   # must pass
bun run build       # must produce dist/ with React app
```

The app won't render real data without Docker running, but it must build and typecheck cleanly.

---

## Commit

```
feat(sideclaw): add React skeleton — routing, theme, repo list, git status bar
```

---

## Done

Append learning notes to `docs/ralph/RALPH_NOTES.md`, then:
```
RALPH_TASK_COMPLETE: Group 4
```
