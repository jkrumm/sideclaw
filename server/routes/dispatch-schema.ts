import { Elysia } from "elysia";
import { z } from "zod";
import {
  DISPATCH_OUTCOMES,
  DISPATCH_OUTPUT,
  DISPATCH_SCHEMA_VERSION,
  WORKER_OUTPUT,
} from "../jobs/handlers/dispatch.ts";

// The dispatch verdict schema (server/jobs/handlers/dispatch.ts), published for a consumer in
// another repo (today: warden) to fetch and pin rather than copy by hand — a copy drifts, and
// drift here presents as "verdict silently ignored". `version` is DISPATCH_SCHEMA_VERSION: a
// consumer pins that number and treats a mismatch as a loud refusal, not a best-effort parse.
// Read-only, like dispatch-policy.ts and routing.ts.

export const dispatchSchemaRoutes = new Elysia({ prefix: "/api" }).get("/dispatch-schema", () => {
  return {
    ok: true as const,
    version: DISPATCH_SCHEMA_VERSION,
    outcomes: DISPATCH_OUTCOMES,
    output: z.toJSONSchema(DISPATCH_OUTPUT),
    worker: {
      investigate: z.toJSONSchema(WORKER_OUTPUT.investigate),
      author: z.toJSONSchema(WORKER_OUTPUT.author),
      implement: z.toJSONSchema(WORKER_OUTPUT.implement),
    },
  };
});
