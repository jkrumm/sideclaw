# Group 1: Project Skeleton & Tooling

## What You're Doing

Scaffold the entire sideclaw project skeleton: package.json with all dependencies, TypeScript config, Vite config, Dockerfile, docker-compose.yml, Makefile, .gitignore, and `.env.example`. No application logic yet — just the foundation that lets all future groups build without surprises.

---

## Research & Exploration First

1. Read `sideclaw/PRD.md` — understand the full stack and Docker setup
2. Research Elysia v1 via Context7: understand the basic app setup, static file serving, and SSE API
3. Research Eden Treaty v2 via Context7: understand how it consumes an Elysia app type
4. Check Bun's official docs for the current `bun init` / package.json conventions
5. Verify latest stable versions: `elysia`, `@elysiajs/static`, BlueprintJS (`@blueprintjs/core` v6), `@dnd-kit/sortable`, `easymde`, `react@19`

---

## What to Implement

### 1. `package.json`

Single package (no workspace). Scripts:
```json
{
  "scripts": {
    "dev:server": "bun --watch server/index.ts",
    "dev:client": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "start": "bun server/index.ts"
  }
}
```

Dependencies (research exact current versions):
- `elysia` + `@elysiajs/static`
- `react@19` + `react-dom@19`
- `react-router-dom` (v7)
- `@blueprintjs/core` v6 + `@blueprintjs/icons` v6
- `easymde`
- `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities`
- `normalize.css` (BlueprintJS peer)

DevDependencies:
- `typescript`
- `vite` + `@vitejs/plugin-react`
- `@types/react` + `@types/react-dom`
- `@types/bun`

### 2. `tsconfig.json`

Strict mode. Two targets:
- `tsconfig.json` — root, references server + src
- `tsconfig.server.json` — targets Bun (module: "Preserve", lib: ["ESNext"])
- `tsconfig.src.json` — targets browser (jsx: "react-jsx", lib: ["ESNext", "DOM"])

### 3. `vite.config.ts`

```typescript
// Key settings:
// - React plugin
// - server.proxy: { '/api': 'http://localhost:7705' } for dev
// - build.outDir: 'dist'
// - optimizeDeps.exclude: [] (no basalt-ui here)
```

### 4. `Dockerfile`

Multi-stage:
1. `FROM oven/bun:1 AS builder` — install deps, build Vite SPA
2. `FROM oven/bun:1` — copy server/, dist/, node_modules (prod only), run `bun server/index.ts`

Port: EXPOSE 7705

### 5. `docker-compose.yml`

```yaml
services:
  sideclaw:
    build: .
    ports:
      - "${CQUEUE_PORT:-7705}:7705"
    volumes:
      - ${SOURCEROOT_PATH}:/repos/SourceRoot:rw
      - ${IUROOT_PATH}:/repos/IuRoot:rw
    user: "${UID:-501}:${GID:-20}"
    restart: unless-stopped
    env_file: ../.env
```

### 6. `Makefile`

```makefile
up:
	docker compose --env-file ../.env up -d --build

down:
	docker compose --env-file ../.env down

rebuild:
	docker compose --env-file ../.env up -d --build --force-recreate

logs:
	docker compose --env-file ../.env logs -f

shell:
	docker compose --env-file ../.env exec sideclaw sh
```

### 7. `.gitignore`

```
node_modules/
dist/
.env
.ralph-tasks.json
.ralph-logs/
*.tmp
```

### 8. `.env.example`

```env
SOURCEROOT_PATH=/Users/yourname/SourceRoot
IUROOT_PATH=/Users/yourname/IuRoot
CQUEUE_PORT=7705
UID=501
GID=20
```

### 9. Minimal `server/index.ts` stub

Just enough to typecheck:
```typescript
import { Elysia } from 'elysia'

const app = new Elysia()
  .get('/health', () => ({ ok: true }))
  .listen(7705)

console.log('sideclaw server running on port 7705')
```

### 10. Minimal `src/main.tsx` stub

Just enough for Vite to build:
```typescript
import React from 'react'
import ReactDOM from 'react-dom/client'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div>sideclaw</div>
  </React.StrictMode>
)
```

### 11. `index.html`

Standard Vite HTML entry. Include the Google Fonts preconnect for JetBrains Mono + Geist Sans (or use a CSS import).

---

## Validation

```bash
bun install              # must resolve without errors
bun run typecheck        # must pass (stubs are minimal — should be clean)
bun run build            # must produce dist/
docker build -t sideclaw-test . && docker rmi sideclaw-test   # image must build
```

---

## Commit

```
feat(sideclaw): scaffold project skeleton — Bun/Elysia/React/Vite/Docker
```

---

## Done

Append learning notes to `docs/ralph/RALPH_NOTES.md`, then:
```
RALPH_TASK_COMPLETE: Group 1
```
