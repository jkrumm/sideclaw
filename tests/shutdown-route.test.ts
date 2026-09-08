// POST /api/shutdown (server/routes/shutdown.ts) against a fake trigger — same `.handle()`
// pattern tests/jobs-health.test.ts uses for jobs.ts, so this stays a route-level test with no
// real server/lib/index.ts side effects (no :7705 bind, no real signal wiring).

import { afterEach, describe, expect, test } from "bun:test";
import { __resetShutdownTriggerForTests, registerShutdownTrigger } from "../server/lib/shutdown.ts";
import { shutdownRoutes } from "../server/routes/shutdown.ts";

const SHUTDOWN_HEADERS = { "X-Sideclaw-Shutdown": "1" };

afterEach(() => {
  __resetShutdownTriggerForTests();
});

describe("POST /api/shutdown", () => {
  test("with no force param, triggers an unforced (drain) shutdown and reports the running count", async () => {
    const calls: boolean[] = [];
    registerShutdownTrigger((force) => {
      calls.push(force);
      return { running: 2 };
    });

    const res = await shutdownRoutes.handle(
      new Request("http://localhost/api/shutdown", { method: "POST", headers: SHUTDOWN_HEADERS }),
    );
    const body = await res.json();

    expect(calls).toEqual([false]);
    expect(body).toEqual({ ok: true, forced: false, running: 2 });
  });

  test("force=1 triggers a forced abort", async () => {
    const calls: boolean[] = [];
    registerShutdownTrigger((force) => {
      calls.push(force);
      return { running: 5 };
    });

    const res = await shutdownRoutes.handle(
      new Request("http://localhost/api/shutdown?force=1", {
        method: "POST",
        headers: SHUTDOWN_HEADERS,
      }),
    );
    const body = await res.json();

    expect(calls).toEqual([true]);
    expect(body).toEqual({ ok: true, forced: true, running: 5 });
  });

  test("force=true (not just force=1) also triggers a forced abort", async () => {
    registerShutdownTrigger((force) => ({ running: force ? 1 : 0 }));

    const res = await shutdownRoutes.handle(
      new Request("http://localhost/api/shutdown?force=true", {
        method: "POST",
        headers: SHUTDOWN_HEADERS,
      }),
    );
    const body = await res.json();

    expect(body).toEqual({ ok: true, forced: true, running: 1 });
  });

  test("any other force value is treated as unforced", async () => {
    registerShutdownTrigger((force) => ({ running: force ? 1 : 0 }));

    const res = await shutdownRoutes.handle(
      new Request("http://localhost/api/shutdown?force=0", {
        method: "POST",
        headers: SHUTDOWN_HEADERS,
      }),
    );
    const body = await res.json();

    expect(body).toEqual({ ok: true, forced: false, running: 0 });
  });

  // `force` is compared with `===` against the literal strings "1"/"true" — pinned here so a
  // differently-cased value being treated as unforced is a decision, not an accident nobody
  // noticed. A flag that decides whether running jobs get discarded deserves that certainty.
  test("force=TRUE (uppercase) is treated as unforced — the comparison is case-sensitive", async () => {
    registerShutdownTrigger((force) => ({ running: force ? 1 : 0 }));

    const res = await shutdownRoutes.handle(
      new Request("http://localhost/api/shutdown?force=TRUE", {
        method: "POST",
        headers: SHUTDOWN_HEADERS,
      }),
    );
    const body = await res.json();

    expect(body).toEqual({ ok: true, forced: false, running: 0 });
  });

  test("force=True (mixed case) is treated as unforced — same case-sensitive comparison", async () => {
    registerShutdownTrigger((force) => ({ running: force ? 1 : 0 }));

    const res = await shutdownRoutes.handle(
      new Request("http://localhost/api/shutdown?force=True", {
        method: "POST",
        headers: SHUTDOWN_HEADERS,
      }),
    );
    const body = await res.json();

    expect(body).toEqual({ ok: true, forced: false, running: 0 });
  });

  test("responds before the trigger's own async work would settle — the trigger returns synchronously", async () => {
    // registerShutdownTrigger's contract is a synchronous callback (index.ts's real one calls
    // onSignal(), itself synchronous — the actual multi-minute drain happens on a later tick,
    // not inside this call). This test pins the type-level contract as a behavioral one: the
    // route must not, itself, ever await the trigger.
    let called = false;
    registerShutdownTrigger((force) => {
      called = true;
      return { running: force ? 9 : 0 };
    });

    const res = await shutdownRoutes.handle(
      new Request("http://localhost/api/shutdown", { method: "POST", headers: SHUTDOWN_HEADERS }),
    );

    expect(called).toBe(true);
    expect(res.status).toBe(200);
  });

  test("no trigger registered → 503, not a crash", async () => {
    const res = await shutdownRoutes.handle(
      new Request("http://localhost/api/shutdown", { method: "POST", headers: SHUTDOWN_HEADERS }),
    );
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body).toEqual({ ok: false, error: "shutdown controller not registered yet" });
  });

  // The cross-origin browser guard: a bodyless POST with only a query string is a CORS "simple
  // request" — no preflight, so a webpage the user has open on any origin could otherwise
  // `fetch` this endpoint directly. Requiring a non-safelisted header forces a preflight this
  // server never answers, which fails the request before it ever reaches this handler in a real
  // browser. Here (no real browser/CORS layer in `.handle()`) that's simulated by asserting the
  // header check itself, and that the trigger is never called without it.
  describe("cross-origin browser guard", () => {
    test("missing X-Sideclaw-Shutdown header is rejected with 403, trigger never called", async () => {
      let called = false;
      registerShutdownTrigger(() => {
        called = true;
        return { running: 0 };
      });

      const res = await shutdownRoutes.handle(
        new Request("http://localhost/api/shutdown", { method: "POST" }),
      );
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body.ok).toBe(false);
      expect(called).toBe(false);
    });

    test("incorrect X-Sideclaw-Shutdown header value is rejected with 403", async () => {
      let called = false;
      registerShutdownTrigger(() => {
        called = true;
        return { running: 0 };
      });

      const res = await shutdownRoutes.handle(
        new Request("http://localhost/api/shutdown", {
          method: "POST",
          headers: { "X-Sideclaw-Shutdown": "0" },
        }),
      );

      expect(res.status).toBe(403);
      expect(called).toBe(false);
    });

    test("the correct header is accepted regardless of casing on the header name (HTTP header names are case-insensitive)", async () => {
      registerShutdownTrigger((force) => ({ running: force ? 1 : 0 }));

      const res = await shutdownRoutes.handle(
        new Request("http://localhost/api/shutdown", {
          method: "POST",
          headers: { "x-sideclaw-shutdown": "1" },
        }),
      );

      expect(res.status).toBe(200);
    });
  });
});
