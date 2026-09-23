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
  requestBody,
  resolveContext,
  resolveRepoSpec,
  run,
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
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const fetchFn = mockFetch(routes);
  return run(
    argv,
    { fetchFn, gitRoot: () => "/repo", cwd: "/repo", env: {} },
    { out: (s) => out.push(s), err: (s) => err.push(s) },
  ).then((code) => ({ code, out: out.join(""), err: err.join("") }));
}

const UNREACHABLE_FETCH: FetchLike = async () => {
  throw new Error("connect refused");
};

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
});
