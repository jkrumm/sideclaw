import type { z } from "zod";

/** Validate raw job params against a handler's input schema, throwing a clean
 *  flattened error. Job params arrive as untyped JSON from the HTTP route, so
 *  every handler re-validates at the execution boundary. */
export function parseParams<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const issues = r.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  throw new Error(`invalid params: ${issues}`);
}
