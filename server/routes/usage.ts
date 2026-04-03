import { Elysia, t } from "elysia";

interface UsageData {
  five_hour_pct: number;
  five_hour_mins_left: number | null;
  seven_day_pct: number | null;
  updated_at: number;
}

let current: UsageData | null = null;

export const usageRoutes = new Elysia({ prefix: "/api" })
  .post(
    "/usage",
    ({ body }) => {
      current = { ...body, updated_at: Date.now() };
      return { ok: true } as const;
    },
    {
      body: t.Object({
        five_hour_pct: t.Number(),
        five_hour_mins_left: t.Nullable(t.Number()),
        seven_day_pct: t.Nullable(t.Number()),
      }),
    },
  )
  .get("/usage", () => ({ ok: true, data: current } as const));
