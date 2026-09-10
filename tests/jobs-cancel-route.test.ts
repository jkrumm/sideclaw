// POST /api/jobs/:id/cancel (server/routes/jobs.ts → server/jobs/store.ts's cancelJob) against
// the real route via `.handle()`, same pattern tests/jobs-health.test.ts and
// tests/shutdown-route.test.ts use. Covers the HTTP-visible contract: 404/409/200 and that a
// cancel never inflates `failedLastHour`. The running-job transition itself (cancelRequested →
// cancelled, not failed) is tests/jobs-cancel-running.test.ts — that needs store.ts's
// lower-level API to inject a controllable executor.

import { afterEach, describe, expect, test } from "bun:test";
import { __resetForTests, createJob, initJobStore } from "../server/jobs/store.ts";
import { jobsRoutes } from "../server/routes/jobs.ts";

afterEach(() => {
  __resetForTests();
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function postCancel(id: string) {
  const res = await jobsRoutes.handle(
    new Request(`http://localhost/api/jobs/${id}/cancel`, { method: "POST" }),
  );
  return { status: res.status, body: await res.json() };
}

describe("POST /api/jobs/:id/cancel", () => {
  test("unknown id → 404", async () => {
    const { status, body } = await postCancel("no-such-job");
    expect(status).toBe(404);
    expect(body).toEqual({ ok: false, error: "job not found" });
  });

  test("already-terminal (done) job → 409", async () => {
    initJobStore({ executor: async () => ({ fine: true }) });
    const created = createJob("check", {});
    await flush();

    const { status, body } = await postCancel(created.id);
    expect(status).toBe(409);
    expect(body).toEqual({ ok: false, error: "job already done" });
  });

  test("pending job → 200, and the job reads cancelled and terminal", async () => {
    // No initJobStore: promote() bails out with no executor registered, so the job stays
    // `pending` forever instead of racing to `running`.
    const created = createJob("check", {});

    const { status, body } = await postCancel(created.id);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.job.status).toBe("cancelled");
    expect(body.job.error).toBe("cancelled by request");

    const res = await jobsRoutes.handle(new Request(`http://localhost/api/jobs/${created.id}`));
    const polled = await res.json();
    expect(polled.job.status).toBe("cancelled");
  });

  test("a cancelled pending job never counts toward failedLastHour", async () => {
    const created = createJob("check", {});
    const { status } = await postCancel(created.id);
    expect(status).toBe(200);

    const res = await jobsRoutes.handle(new Request("http://localhost/api/jobs/health"));
    const body = await res.json();
    expect(body.failedLastHour).toBe(0);
  });
});
