import { Elysia } from "elysia";
import { z } from "zod";
import { REVIEW_OUTCOMES, REVIEW_OUTPUT, REVIEW_SCHEMA_VERSION } from "../jobs/handlers/review.ts";

// The review verdict schema (server/jobs/handlers/review.ts), published for a consumer in
// another repo (today: warden) to fetch and pin rather than copy by hand — a copy drifts, and
// drift here presents as "verdict silently ignored". `version` is REVIEW_SCHEMA_VERSION: a
// consumer pins that number and treats a mismatch as a loud refusal, not a best-effort parse.
// Mirrors dispatch-schema.ts. Read-only.

export const reviewSchemaRoutes = new Elysia({ prefix: "/api" }).get("/review-schema", () => {
  return {
    ok: true as const,
    version: REVIEW_SCHEMA_VERSION,
    outcomes: REVIEW_OUTCOMES,
    output: z.toJSONSchema(REVIEW_OUTPUT),
  };
});
