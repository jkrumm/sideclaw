import { Elysia } from "elysia";
import { dispatchPolicy } from "../lib/dispatch-policy.ts";

// The effective dispatch repo policy (server/lib/dispatch-policy.ts) — which roots a `cwd`
// must sit directly under, the per-repo tier ceiling/sensitivity table, and every
// SIDECLAW_DISPATCH_*  override that was applied or refused. Read-only; what an operator
// checks after flipping an env var and running `make reload`.

export const dispatchPolicyRoutes = new Elysia({ prefix: "/api" }).get("/dispatch-policy", () => {
  const { roots, rules, overrides } = dispatchPolicy();
  return { ok: true as const, roots, rules, overrides };
});
