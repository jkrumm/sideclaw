import { Elysia, t } from "elysia";
import { triggerShutdown } from "../lib/shutdown.ts";

// Self-initiated graceful shutdown — the counterpart to `make reload`'s old `launchctl kill`.
// launchd's `ExitTimeOut` is hard-capped at 60s regardless of what the plist says (measured
// 2026-09-08, see server/lib/shutdown.ts's two-window note) — far too short for a `review`
// (p50 345s) or a `dispatch implement` worker mid-commit to survive a launchd-issued SIGTERM.
// That cap only applies when LAUNCHD sends the signal and waits for the exit, though: a process
// that exits ON ITS OWN never starts that clock, so a self-initiated exit can drain for as long
// as HTTP_DRAIN_GRACE_MS allows, then KeepAlive restarts it exactly like any other exit.
//
// No auth beyond the loopback bind (server/index.ts binds 127.0.0.1 only) — same line as every
// other route here, including POST /api/jobs, which can already submit a dispatch `implement`
// episode with no credential of its own. This endpoint can stop the process, but stopping it
// doesn't cross a privilege boundary that submitting an implement job doesn't already cross, so
// it gets no special authentication of its own — any local process sharing this Mac's UID can
// still stop the server, exactly as it could already send it a real OS signal.
//
// What loopback-only does NOT cover, though, is a browser tab: a bodyless POST with only a query
// string (no body, no non-safelisted Content-Type) is a CORS "simple request" — a webpage the
// user has open, on ANY origin, can `fetch("http://127.0.0.1:7705/api/shutdown", { method:
// "POST" })` with no preflight and no way for this server to refuse it, because the browser never
// asks first. Before `POST /api/shutdown` existed, triggering a forced abort needed OS signal
// privileges; now it needs one `fetch` call from a tab the user happens to have open. Requiring a
// header outside the CORS-safelisted set (`x-sideclaw-shutdown`, matching the `x-lock-token`
// convention in routes/diagrams.ts) forces the browser to send a preflight OPTIONS request first
// — which this server never answers with an `Access-Control-Allow-*` response, so the actual POST
// never fires. A same-origin caller (`curl` in the Makefile) sets the header trivially. This is
// NOT authentication — it closes exactly one vector (a background browser tab), not the one this
// route was never meant to close (any local process with this UID, which could already signal it).
const SHUTDOWN_HEADER = "x-sideclaw-shutdown";

export const shutdownRoutes = new Elysia({ prefix: "/api" }).post(
  "/shutdown",
  ({ query, request, set }) => {
    if (request.headers.get(SHUTDOWN_HEADER) !== "1") {
      set.status = 403;
      return {
        ok: false as const,
        error: `missing or incorrect ${SHUTDOWN_HEADER} header — required so a cross-origin browser fetch (no CORS preflight otherwise) can't trigger this endpoint`,
      };
    }
    const force = query.force === "1" || query.force === "true";
    const result = triggerShutdown(force);
    if (!result) {
      // Only reachable if this route somehow answers a request before index.ts finishes
      // wiring registerShutdownTrigger() — registration happens synchronously at module load,
      // before the HTTP listener can serve a first request, so this is a defensive default,
      // not an expected runtime path.
      set.status = 503;
      return { ok: false as const, error: "shutdown controller not registered yet" };
    }
    return { ok: true as const, forced: force, running: result.running };
  },
  {
    // Query, not a JSON body — `make reload`'s curl call needs no `-d`/Content-Type to trigger
    // this, just an optional `?force=1` (and the `X-Sideclaw-Shutdown` header, see above).
    query: t.Object({ force: t.Optional(t.String()) }),
  },
);
