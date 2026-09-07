import { Elysia } from "elysia";
import { routingTable } from "../lib/routing.ts";

// The effective per-tool `{ model, backend, fallback }` table (server/lib/routing.ts) plus
// every SIDECLAW_MODEL_*/SIDECLAW_BACKEND_* override that was applied or refused. Read-only;
// what an operator checks after flipping an env var and running `make reload`.

export const routingRoutes = new Elysia({ prefix: "/api" }).get("/routing", () => {
  const { routes, overrides } = routingTable();
  return { ok: true as const, routes, overrides };
});
