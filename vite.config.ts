import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 7705,
    allowedHosts: ['sideclaw.local'],
    watch: {
      // Ignore content files that change at runtime — not source code
      ignored: ['**/sc-queue.md', '**/sc-note.md', '**/docs/diagrams/**'],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:7706',
        changeOrigin: true,
        // SSE streams need no timeout and no compression buffering
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if ((req.headers.accept as string)?.includes('text/event-stream')) {
              proxyReq.setHeader('Accept-Encoding', 'identity')
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ;(proxyReq.socket as any)?.setTimeout(0)
            }
          })
        },
      },
    },
  },
  build: {
    outDir: 'dist',
  },
  // Pre-bundle excalidraw so Vite doesn't discover hundreds of sub-imports at
  // runtime and trigger a hard reload. CSS import in ExcalidrawLazy resolves
  // via the package exports map and is unaffected by pre-bundling.
  optimizeDeps: {
    include: ['@excalidraw/excalidraw'],
  },
})
