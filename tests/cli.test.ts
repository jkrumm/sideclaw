// The harness-agnostic CLI (bin/sideclaw.ts). These pin the argv → POST-body mapping,
// the `--repo` name→path resolution, the exit-code mapping, and that `--json` keeps stdout
// pure JSON — all against exported pure functions plus one mocked-fetch round trip, so no
// test spawns a server.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, afterAll } from "bun:test";
import {
  exitCodeFor,
  formatDuration,
  parseArgs,
  renderCheckResult,
  renderVerdictResult,
  requestBody,
  resolveContext,
  resolveRepoSpec,
  run,
  type CliContext,
  type FetchLike,
  type JobCommand,
  type RequestBody,
} from "../bin/sideclaw.ts";

function bodyFor(argv: string[], cwd = "/repo"): RequestBody {
  const { command } = parseArgs(argv);
  const job = command as JobCommand;
  const context = job.kind === "dispatch" ? resolveContext(job.context, () => "file") : undefined;
  return requestBody(job, { cwd, context });
}

describe("argv parsing → POST body", () => {
  test("dispatch, defaults only", () => {
    const { command } = parseArgs(["dispatch", "fix the bug"]);
    expect(command).toMatchObject({ kind: "dispatch", brief: "fix the bug" });
    expect(bodyFor(["dispatch", "fix the bug"])).toEqual({
      tool: "dispatch",
      params: { cwd: "/repo", brief: "fix the bug" },
    });
  });

  test("dispatch, every flag", () => {
    expect(
      bodyFor([
        "dispatch",
        "--repo",
        "/abs/repo",
        "--tier",
        "implement",
        "--workspace",
        "in-place",
        "--model",
        "claude-opus-5",
        "--context",
        "raw logs",
        "--sensitive",
        "fix the bug",
      ]),
    ).toEqual({
      tool: "dispatch",
      params: {
        cwd: "/repo",
        brief: "fix the bug",
        tier: "implement",
        workspace: "in-place",
        model: "claude-opus-5",
        context: "raw logs",
        sensitive: true,
      },
    });
  });

  test("dispatch brief is the joined positionals", () => {
    expect(bodyFor(["dispatch", "the", "monitor", "went", "red"])).toMatchObject({
      params: { brief: "the monitor went red" },
    });
  });

  test("dispatch --context @file is a file spec until resolved", () => {
    const { command } = parseArgs(["dispatch", "--context", "@/tmp/logs.txt", "x"]);
    expect(command).toMatchObject({
      kind: "dispatch",
      context: { kind: "file", path: "/tmp/logs.txt" },
    });
  });

  test("check forwards commands as an array", () => {
    expect(bodyFor(["check", "--repo", "/repo", "--commands", "lint, test "])).toEqual({
      tool: "check",
      params: { cwd: "/repo", commands: ["lint", "test"] },
    });
    expect(bodyFor(["check"])).toEqual({ tool: "check", params: { cwd: "/repo" } });
  });

  test("review maps scope, pr (number) and branch", () => {
    expect(bodyFor(["review", "--scope", "HEAD~2"])).toEqual({
      tool: "review",
      params: { cwd: "/repo", scope: "HEAD~2" },
    });
    expect(bodyFor(["review", "--pr", "42"])).toEqual({
      tool: "review",
      params: { cwd: "/repo", pr: 42 },
    });
    expect(bodyFor(["review", "--branch", "dispatch/foo"])).toEqual({
      tool: "review",
      params: { cwd: "/repo", branch: "dispatch/foo" },
    });
  });

  test("inspect commands parse to their kind", () => {
    expect(parseArgs(["jobs"]).command).toEqual({ kind: "jobs", running: false });
    expect(parseArgs(["jobs", "--running"]).command).toEqual({ kind: "jobs", running: true });
    expect(parseArgs(["status", "abc"]).command).toEqual({ kind: "status", jobId: "abc" });
    expect(parseArgs(["wait", "abc"]).command).toEqual({ kind: "wait", jobId: "abc" });
    expect(parseArgs(["cancel", "abc"]).command).toEqual({ kind: "cancel", jobId: "abc" });
    expect(parseArgs(["routing"]).command).toEqual({ kind: "routing" });
    expect(parseArgs(["policy"]).command).toEqual({ kind: "policy" });
    expect(parseArgs(["health"]).command).toEqual({ kind: "health" });
  });

  test("usage errors fail at parse time, not at the server", () => {
    expect(() => parseArgs(["dispatch"])).toThrow("requires a <brief>");
    expect(() => parseArgs(["dispatch", "--tier", "bogus", "x"])).toThrow("--tier");
    expect(() => parseArgs(["dispatch", "--workspace", "bogus", "x"])).toThrow("--workspace");
    expect(() => parseArgs(["review", "--scope", "a", "--pr", "1"])).toThrow("mutually exclusive");
    expect(() => parseArgs(["check", "--tier", "x"])).toThrow("unknown flag --tier");
    expect(() => parseArgs(["status"])).toThrow("<jobId>");
    expect(() => parseArgs(["nonsense"])).toThrow("unknown command");
    expect(() => parseArgs(["health", "extra"])).toThrow("takes no arguments");
  });

  test("global flags are extracted and no longer reach the subcommand", () => {
    expect(parseArgs(["--json", "health"]).options).toMatchObject({ json: true });
    expect(parseArgs(["dispatch", "--no-wait", "x"]).options).toMatchObject({ noWait: true });
    expect(parseArgs(["dispatch", "--timeout", "30", "x"]).options).toMatchObject({
      timeoutSec: 30,
    });
    expect(() => parseArgs(["--timeout", "0", "health"])).toThrow("--timeout");
    expect(() => parseArgs(["--timeout", "nope", "health"])).toThrow("--timeout");
  });
});

describe("--repo resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "sideclaw-cli-root-"));
  mkdirSync(join(root, "my-repo"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("a bare name resolves under a dispatch root", () => {
    expect(
      resolveRepoSpec(
        { kind: "name", name: "my-repo" },
        {
          cwd: root,
          roots: [root],
          gitRoot: () => null,
        },
      ),
    ).toBe(join(root, "my-repo"));
  });

  test("an absolute path is normalized and passed through", () => {
    expect(
      resolveRepoSpec(
        { kind: "path", path: "/a/../b" },
        { cwd: "/", roots: [], gitRoot: () => null },
      ),
    ).toBe("/b");
  });

  test("the default is the git root of cwd", () => {
    expect(
      resolveRepoSpec(
        { kind: "default" },
        { cwd: "/some/deep/dir", roots: [], gitRoot: () => "/git/root" },
      ),
    ).toBe("/git/root");
  });

  test("default outside a git repo is a usage error", () => {
    expect(() =>
      resolveRepoSpec({ kind: "default" }, { cwd: "/", roots: [], gitRoot: () => null }),
    ).toThrow("not inside a git repository");
  });

  test("a name under no root is a usage error naming the searched paths", () => {
    expect(() =>
      resolveRepoSpec(
        { kind: "name", name: "nope" },
        { cwd: "/", roots: [root], gitRoot: () => null },
      ),
    ).toThrow("no such repo");
  });

  test("--repo rejects a relative path", () => {
    expect(() => parseArgs(["dispatch", "--repo", "./rel", "x"])).toThrow("--repo");
  });
});

describe("context resolution", () => {
  test("literal text passes through, @file reads", () => {
    expect(resolveContext({ kind: "text", text: "abc" }, () => "unused")).toBe("abc");
    expect(resolveContext({ kind: "file", path: "p" }, () => "contents")).toBe("contents");
    expect(resolveContext(undefined, () => "unused")).toBeUndefined();
  });

  test("an unreadable file is a usage error", () => {
    expect(() =>
      resolveContext({ kind: "file", path: "p" }, () => {
        throw new Error("ENOENT");
      }),
    ).toThrow("could not read --context file");
  });
});

describe("exit-code mapping", () => {
  test("done → 0, failed/interrupted/cancelled → 1", () => {
    expect(exitCodeFor("done", null)).toBe(0);
    expect(exitCodeFor("failed", "something broke")).toBe(1);
    expect(exitCodeFor("interrupted", null)).toBe(1);
    expect(exitCodeFor("cancelled", "cancelled by request")).toBe(1);
  });

  test("a dispatch refusal surfaces as exit 2", () => {
    expect(exitCodeFor("failed", "dispatch refused: cwd is outside every root")).toBe(2);
  });
});

describe("formatDuration", () => {
  test("seconds, minutes, hours", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(192_000)).toBe("3m12s");
    expect(formatDuration(7_380_000)).toBe("2h3m0s");
  });
});

// ── One mocked-fetch round trip (submit → poll → done) ───────────────────────────

type MockResponse = { status?: number; body: unknown };
function mockFetch(routes: Record<string, (init?: RequestInit) => MockResponse>): FetchLike {
  return async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    const handler = routes[key];
    if (handler === undefined) throw new Error(`unmocked route: ${key}`);
    const { status = 200, body } = handler(init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

const VERDICT = {
  summary: "one line",
  verdict: "what happened",
  confidence: "high",
  evidence: [],
  recommendation: "next step",
  nextAction: "none",
  outcome: "verdict_only",
  schemaVersion: 3,
};

const DONE_JOB = {
  id: "j1",
  tool: "dispatch",
  status: "done",
  result: VERDICT,
  error: null,
  progress: { turns: 2, lastAction: "Edit x.ts" },
  elapsedMs: 192_000,
  idleMs: null,
};

function runWith(
  argv: string[],
  routes: Record<string, (init?: RequestInit) => MockResponse>,
  ctxOverrides: Partial<CliContext> = {},
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const fetchFn = mockFetch(routes);
  return run(
    argv,
    { fetchFn, gitRoot: () => "/repo", cwd: "/repo", env: {}, ...ctxOverrides },
    { out: (s) => out.push(s), err: (s) => err.push(s) },
  ).then((code) => ({ code, out: out.join(""), err: err.join("") }));
}

const UNREACHABLE_FETCH: FetchLike = async () => {
  throw new Error("connect refused");
};

/** Skips real wall-clock delays — injected as `sleepFn` for tests that would otherwise pay
 *  for POLL_MS/retry-backoff waits (seconds of real time) for no assertion value. */
const INSTANT_SLEEP = async (): Promise<void> => {};

/** Like `mockFetch`, but a handler can also throw (simulating a network failure) or return
 *  a never-settling promise that only resolves/rejects on the request's own AbortSignal —
 *  needed for the retry and `--timeout` tests, which `mockFetch`'s always-succeeds shape
 *  can't express. `callIndex` is 0 on a route's first call, incrementing per route. */
function routedFetch(
  handlers: Record<
    string,
    (init: RequestInit | undefined, callIndex: number) => Response | Promise<Response>
  >,
): FetchLike {
  const counts: Record<string, number> = {};
  return async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    const handler = handlers[key];
    if (handler === undefined) throw new Error(`unmocked route: ${key}`);
    const callIndex = counts[key] ?? 0;
    counts[key] = callIndex + 1;
    return handler(init, callIndex);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("mocked round trip", () => {
  test("dispatch --json emits only the result JSON on stdout", async () => {
    let posted: string | undefined;
    const { code, out, err } = await runWith(["dispatch", "--repo", "/repo", "--json", "do it"], {
      "POST /api/jobs": (init) => {
        posted = init?.body as string;
        return { body: { ok: true, job: { id: "j1" } } };
      },
      "GET /api/jobs/j1": () => ({ body: { ok: true, job: DONE_JOB } }),
    });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(VERDICT);
    expect(out).toBe(`${JSON.stringify(VERDICT, null, 2)}\n`);
    expect(err).toBe("");
    expect(JSON.parse(posted ?? "")).toEqual({
      tool: "dispatch",
      params: { cwd: "/repo", brief: "do it" },
    });
  });

  test("--no-wait prints the jobId and exits 0", async () => {
    const { code, out } = await runWith(["dispatch", "--repo", "/repo", "--no-wait", "do it"], {
      "POST /api/jobs": () => ({ body: { ok: true, job: { id: "j1" } } }),
    });
    expect(code).toBe(0);
    expect(out).toBe("j1\n");
  });

  test("a submit-time refusal exits 2", async () => {
    const { code, err } = await runWith(["dispatch", "--repo", "/repo", "do it"], {
      "POST /api/jobs": () => ({
        status: 400,
        body: { ok: false, error: "dispatch refused: cwd is outside every root" },
      }),
    });
    expect(code).toBe(2);
    expect(err).toContain("dispatch refused");
  });

  test("a failed job exits 1", async () => {
    const { code, err } = await runWith(["dispatch", "--repo", "/repo", "do it"], {
      "POST /api/jobs": () => ({ body: { ok: true, job: { id: "j1" } } }),
      "GET /api/jobs/j1": () => ({
        body: {
          ok: true,
          job: { ...DONE_JOB, status: "failed", result: null, error: "worker died" },
        },
      }),
    });
    expect(code).toBe(1);
    expect(err).toContain("worker died");
  });

  test("an unreachable server exits 3 with the LaunchAgent hint", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(
      ["health"],
      { fetchFn: UNREACHABLE_FETCH, gitRoot: () => "/repo", cwd: "/repo", env: {} },
      { out: (s) => out.push(s), err: (s) => err.push(s) },
    );
    expect(code).toBe(3);
    expect(err.join("")).toContain("unreachable");
    expect(err.join("")).toContain("install-agent");
  });

  test("a failed job in --json mode: stdout is only JSON, the error line goes to stderr, exit 1", async () => {
    const { code, out, err } = await runWith(["dispatch", "--repo", "/repo", "--json", "do it"], {
      "POST /api/jobs": () => ({ body: { ok: true, job: { id: "j1" } } }),
      "GET /api/jobs/j1": () => ({
        body: {
          ok: true,
          job: { ...DONE_JOB, status: "failed", result: null, error: "worker died" },
        },
      }),
    });
    expect(code).toBe(1);
    expect(out).toBe(`${JSON.stringify(null, null, 2)}\n`);
    expect(err).toContain("worker died");
  });
});

// ── --timeout: bounds a hung poll, and never accepts a result that arrives late ──

describe("--timeout", () => {
  test("a poll that never settles is aborted at the deadline and exits 1", async () => {
    const fetchFn = routedFetch({
      "POST /api/jobs": () => jsonResponse({ ok: true, job: { id: "j1" } }),
      "GET /api/jobs/j1": (init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const abortErr = new Error("aborted");
            abortErr.name = "AbortError";
            reject(abortErr);
          });
        }),
    });
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(
      ["dispatch", "--repo", "/repo", "--timeout", "1", "do it"],
      { fetchFn, gitRoot: () => "/repo", cwd: "/repo", env: {} },
      { out: (s) => out.push(s), err: (s) => err.push(s) },
    );
    expect(code).toBe(1);
    expect(err.join("")).toContain("timed out after 1s");
    expect(out.join("")).toBe("");
  }, 10_000);

  test("a poll resolving after the deadline is not accepted as a result", async () => {
    const fetchFn = routedFetch({
      "POST /api/jobs": () => jsonResponse({ ok: true, job: { id: "j1" } }),
      // Ignores the AbortSignal entirely — simulates a slow response racing the deadline,
      // the case the post-await re-check (not just the AbortController) has to catch.
      "GET /api/jobs/j1": async () => {
        await new Promise((r) => setTimeout(r, 1200));
        return jsonResponse({ ok: true, job: DONE_JOB });
      },
    });
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(
      ["dispatch", "--repo", "/repo", "--timeout", "1", "do it"],
      { fetchFn, gitRoot: () => "/repo", cwd: "/repo", env: {} },
      { out: (s) => out.push(s), err: (s) => err.push(s) },
    );
    expect(code).toBe(1);
    expect(err.join("")).toContain("timed out after 1s");
    expect(out.join("")).toBe("");
  }, 10_000);
});

// ── Poll resilience: a transient failure (e.g. a `make reload` restart window) retries ──

describe("poll resilience", () => {
  test("a transient poll failure is retried with backoff and the job still completes", async () => {
    const fetchFn = routedFetch({
      "POST /api/jobs": () => jsonResponse({ ok: true, job: { id: "j1" } }),
      "GET /api/jobs/j1": (_init, callIndex) => {
        if (callIndex === 0) throw new Error("connect refused");
        return jsonResponse({ ok: true, job: DONE_JOB });
      },
    });
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(
      ["dispatch", "--repo", "/repo", "do it"],
      { fetchFn, gitRoot: () => "/repo", cwd: "/repo", env: {}, sleepFn: INSTANT_SLEEP },
      { out: (s) => out.push(s), err: (s) => err.push(s) },
    );
    expect(code).toBe(0);
    expect(out.join("")).toContain("one line");
    expect(err.join("")).toContain("poll failed");
    expect(err.join("")).toContain("poll recovered after 1 failed attempt");
  });

  test("exhausted poll retries give up and exit 3", async () => {
    const fetchFn = routedFetch({
      "POST /api/jobs": () => jsonResponse({ ok: true, job: { id: "j1" } }),
      "GET /api/jobs/j1": () => {
        throw new Error("connect refused");
      },
    });
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(
      ["dispatch", "--repo", "/repo", "do it"],
      { fetchFn, gitRoot: () => "/repo", cwd: "/repo", env: {}, sleepFn: INSTANT_SLEEP },
      { out: (s) => out.push(s), err: (s) => err.push(s) },
    );
    expect(code).toBe(3);
    expect(err.join("")).toContain("unreachable");
  });
});

// ── Progress dedupe: identical pending/running snapshots print once, the final result once ──

describe("progress rendering", () => {
  test("pending→running→done: progress lines dedupe, the final result renders exactly once", async () => {
    const states = [
      { ...DONE_JOB, status: "pending", result: null, error: null, progress: null },
      { ...DONE_JOB, status: "pending", result: null, error: null, progress: null }, // dup
      {
        ...DONE_JOB,
        status: "running",
        result: null,
        error: null,
        progress: { turns: 1, lastAction: "Read a.ts" },
      },
      {
        ...DONE_JOB,
        status: "running",
        result: null,
        error: null,
        progress: { turns: 1, lastAction: "Read a.ts" },
      }, // dup
      {
        ...DONE_JOB,
        status: "running",
        result: null,
        error: null,
        progress: { turns: 2, lastAction: "Edit b.ts" },
      }, // new progress
      DONE_JOB,
    ];
    const fetchFn = routedFetch({
      "POST /api/jobs": () => jsonResponse({ ok: true, job: { id: "j1" } }),
      "GET /api/jobs/j1": (_init, callIndex) =>
        jsonResponse({ ok: true, job: states[Math.min(callIndex, states.length - 1)] }),
    });
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(
      ["dispatch", "--repo", "/repo", "do it"],
      { fetchFn, gitRoot: () => "/repo", cwd: "/repo", env: {}, sleepFn: INSTANT_SLEEP },
      { out: (s) => out.push(s), err: (s) => err.push(s) },
    );
    expect(code).toBe(0);
    const progressLines = err.filter((l) => l.length > 0);
    expect(progressLines).toHaveLength(3);
    const resultOccurrences = out.join("").split("one line").length - 1;
    expect(resultOccurrences).toBe(1);
  });
});

// ── Inspect commands — mocked round trips through run() ──────────────────────────

describe("inspect commands — mocked round trips", () => {
  test("status: GET /api/jobs/:id, exit reflects the job's terminal state", async () => {
    let method: string | undefined;
    const { code, out } = await runWith(["status", "j1"], {
      "GET /api/jobs/j1": (init) => {
        method = init?.method ?? "GET";
        return { body: { ok: true, job: DONE_JOB } };
      },
    });
    expect(method).toBe("GET");
    expect(code).toBe(0);
    expect(out).toContain("j1");
  });

  test("jobs --running: GET /api/jobs, filters out terminal jobs", async () => {
    const { code, out } = await runWith(["jobs", "--running"], {
      "GET /api/jobs": () => ({
        body: {
          ok: true,
          jobs: [DONE_JOB, { ...DONE_JOB, id: "j2", status: "running" }],
        },
      }),
    });
    expect(code).toBe(0);
    expect(out).toContain("j2");
    expect(out).not.toContain("j1");
  });

  test("cancel: POST /api/jobs/:id/cancel, exit 0", async () => {
    let method: string | undefined;
    const { code, out } = await runWith(["cancel", "j1"], {
      "POST /api/jobs/j1/cancel": (init) => {
        method = init?.method;
        return { body: { job: { ...DONE_JOB, id: "j1", status: "cancelled" } } };
      },
    });
    expect(method).toBe("POST");
    expect(code).toBe(0);
    expect(out).toBe("cancelled j1\n");
  });
});

// ── Human-readable render helpers ─────────────────────────────────────────────────

describe("human-readable rendering", () => {
  test("renderVerdictResult renders a dispatch verdict", () => {
    // VERDICT's own fields are widened to `string` (no `as const`, since the existing
    // mocked-round-trip tests below compare it against loosely-typed job.result JSON) — this
    // fixture narrows just the literal-union fields renderVerdictResult's DispatchOutput
    // parameter requires.
    const verdict = {
      ...VERDICT,
      confidence: "high" as const,
      nextAction: "none" as const,
      outcome: "verdict_only" as const,
      schemaVersion: 3 as const,
    };
    const text = renderVerdictResult(verdict);
    expect(text).toContain("one line");
    expect(text).toContain("what happened");
    expect(text).toContain("confidence: high");
    expect(text).toContain("outcome: verdict_only");
    expect(text).toContain("nextAction: none");
    expect(text).toContain("recommendation: next step");
  });

  test("renderCheckResult renders a check result", () => {
    const checkResult = {
      passed: false,
      steps: [
        { name: "lint", passed: true },
        { name: "test", passed: false, errors: ["assertion failed"] },
      ],
      summary: "1/2 failed: test (1 error)",
    };
    const text = renderCheckResult(checkResult);
    expect(text).toContain("1/2 failed: test (1 error)");
    expect(text).toContain("[ok] lint");
    expect(text).toContain("[FAIL] test — assertion failed");
  });
});
