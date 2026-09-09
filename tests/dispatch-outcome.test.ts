// The typed `outcome`/`schemaVersion` fields on DISPATCH_OUTPUT (server/jobs/handlers/dispatch.ts)
// — added so a consumer (warden) can classify a dispatch verdict without substring-matching
// `artifactNote`'s prose. Exercises the two seams that don't require a live worker session:
// `depositBranch` (the implement-tier artifact logic, factored out of `runDispatch`'s switch,
// pure git — no network) and `salvage`/`applySensitiveScan` (also exported, no network). See the
// report for which of the eleven outcomes have NO such seam and are therefore untested here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import {
  applySensitiveScan,
  DISPATCH_OUTCOMES,
  DISPATCH_SCHEMA_VERSION,
  depositBranch,
  salvage,
  type DispatchOutput,
} from "../server/jobs/handlers/dispatch.ts";
import {
  commitPendingWork,
  createReadWorktree,
  createWorktree,
  type RepoIdentity,
} from "../server/jobs/handlers/dispatch-git.ts";
import { dispatchSchemaRoutes } from "../server/routes/dispatch-schema.ts";
import { Fixture, makeFixture } from "./git-fixture.ts";

let fx: Fixture;

beforeEach(async () => {
  fx = await makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

const ID: RepoIdentity = { owner: "jkrumm", repo: "fixture", defaultBranch: "master" };

function key(): string {
  return randomUUID();
}

/** A minimal, schema-valid verdict — every DISPATCH_OUTPUT field is required by the type, but
 *  `depositBranch` only reads `prTitle`/`prBody`/`verdict`, so the rest are placeholders. */
function baseVerdict(overrides: Partial<DispatchOutput> = {}): DispatchOutput {
  return {
    verdict: "placeholder verdict",
    confidence: "medium",
    evidence: [],
    recommendation: "placeholder recommendation",
    nextAction: "none",
    summary: "placeholder summary",
    outcome: "verdict_only",
    schemaVersion: DISPATCH_SCHEMA_VERSION,
    prTitle: "",
    prBody: "",
    ...overrides,
  };
}

// A real AWS access key id shape — the same pattern dispatch-worktree.test.ts's "artifact
// refusals" section uses to trip `assertNoSecrets` without any network call.
const SECRET_BODY = "AKIAIOSFODNN7EXAMPLE";

// ── depositBranch — the implement-tier outcomes ─────────────────────────────────

describe("depositBranch outcomes", () => {
  test("no_changes — the episode committed nothing", async () => {
    const wt = await createWorktree(fx.repo, key(), "noop", "master");
    const result = await depositBranch(wt, ID, baseVerdict(), "brief", () => {});
    expect(result.outcome).toBe("no_changes");
    expect(result.artifactUrl).toBeUndefined();
    expect(result.branch).toBeUndefined();
    expect(result.note).toMatch(/episode changed nothing/);
  });

  test("diff_refused — the diff trips a bound and the branch is discarded", async () => {
    const wt = await createWorktree(fx.repo, key(), "oversized", "master");
    // One file over the per-run ceiling (40 files) is the cheapest bound to trip without
    // building a huge diff.
    for (let i = 0; i < 41; i++) {
      fx.write(`generated/file-${i}.txt`, `content ${i}\n`, wt.path);
    }
    await commitPendingWork(wt, "too many files");
    const result = await depositBranch(wt, ID, baseVerdict(), "brief", () => {});
    expect(result.outcome).toBe("diff_refused");
    expect(result.artifactUrl).toBeUndefined();
    expect(result.branch).toBeUndefined();
    expect(result.note).toMatch(/DISCARDED/);
  });

  test("branch_no_pr — changes pushed, but the worker authored no PR text", async () => {
    const wt = await createWorktree(fx.repo, key(), "silent", "master");
    fx.write("added.txt", "content\n", wt.path);
    await commitPendingWork(wt, "work worth pushing");
    const result = await depositBranch(
      wt,
      ID,
      baseVerdict({ prTitle: "", prBody: "" }),
      "brief",
      () => {},
    );
    expect(result.outcome).toBe("branch_no_pr");
    expect(result.branch).toBe(wt.branch);
    expect(result.artifactUrl).toBeUndefined();
    expect(result.note).toMatch(/NO pull request was opened/);
  });

  test("pr_failed — pushed, but the PR body carries a secret so opening it throws", async () => {
    const wt = await createWorktree(fx.repo, key(), "leaky-pr", "master");
    fx.write("added.txt", "content\n", wt.path);
    await commitPendingWork(wt, "work worth pushing");
    const result = await depositBranch(
      wt,
      ID,
      baseVerdict({ prTitle: "Fix the thing", prBody: SECRET_BODY }),
      "brief",
      () => {},
    );
    expect(result.outcome).toBe("pr_failed");
    expect(result.branch).toBe(wt.branch);
    expect(result.artifactUrl).toBeUndefined();
    expect(result.note).toMatch(/pull request could NOT be opened/);
  });

  // pr_opened (a real `octokit().pulls.create` success) needs a live GitHub API call — no
  // seam exists to fake that without network/credentials. Left untested; see the report.
});

// ── salvage — the tool-failure outcome ──────────────────────────────────────────

describe("salvage outcome", () => {
  test("salvaged, with schemaVersion, when the episode never serialized", async () => {
    const output = await salvage(
      { ok: false, noOutput: true, error: "no structured output" },
      undefined,
      { cwd: fx.repo, tier: "investigate", brief: "brief", startMs: performance.now() },
      undefined,
      undefined,
      () => {},
    );
    expect(output.outcome).toBe("salvaged");
    expect(output.schemaVersion).toBe(DISPATCH_SCHEMA_VERSION);
    expect(output.degraded).toBe(true);
    expect(output.nextAction).toBe("human");
  });

  test("salvaged implement tier pushes the branch it found, still reports outcome salvaged", async () => {
    const wt = await createWorktree(fx.repo, key(), "salvaged-work", "master");
    fx.write("half-done.txt", "unstructured edit\n", wt.path);
    const output = await salvage(
      { ok: false, noOutput: true, error: "no structured output" },
      undefined,
      { cwd: fx.repo, tier: "implement", brief: "brief", startMs: performance.now() },
      wt,
      ID,
      () => {},
    );
    expect(output.outcome).toBe("salvaged");
    expect(output.branch).toBe(wt.branch);
  });
});

// ── applySensitiveScan — withheld wins over everything ──────────────────────────

describe("applySensitiveScan precedence", () => {
  test("withheld overwrites a tier-specific outcome on the success path", () => {
    const clean = baseVerdict({
      outcome: "pr_opened",
      artifactUrl: "https://github.com/jkrumm/fixture/pull/1",
      branch: "dispatch/x-1234",
      verdict: `see ${SECRET_BODY}`,
    });
    const scanned = applySensitiveScan(clean, {
      sensitive: true,
      jobId: "job-1",
      project: fx.repo,
    });
    expect(scanned.outcome).toBe("withheld");
    expect(scanned.schemaVersion).toBe(DISPATCH_SCHEMA_VERSION);
    expect(scanned.nextAction).toBe("human");
    expect(scanned.verdict).toMatch(/Verdict withheld/);
  });

  test("withheld overwrites a salvaged outcome too", () => {
    const salvaged = baseVerdict({
      outcome: "salvaged",
      degraded: true,
      verdict: `raw dump containing ${SECRET_BODY}`,
    });
    const scanned = applySensitiveScan(salvaged, {
      sensitive: true,
      jobId: "job-2",
      project: fx.repo,
    });
    expect(scanned.outcome).toBe("withheld");
  });

  test("a clean verdict is returned byte-identical, outcome untouched", () => {
    const clean = baseVerdict({ outcome: "issue_filed" });
    const scanned = applySensitiveScan(clean, {
      sensitive: true,
      jobId: "job-3",
      project: fx.repo,
    });
    expect(scanned).toBe(clean);
    expect(scanned.outcome).toBe("issue_filed");
  });

  test("not scanned at all when sensitive is false", () => {
    const clean = baseVerdict({ outcome: "pr_opened", verdict: SECRET_BODY });
    const scanned = applySensitiveScan(clean, {
      sensitive: false,
      jobId: "job-4",
      project: fx.repo,
    });
    expect(scanned.outcome).toBe("pr_opened");
  });
});

// ── read-tier worktree sanity for the salvage seam ──────────────────────────────
// (kept tiny — full read-worktree behavior is dispatch-worktree.test.ts's territory)

describe("salvage on a read-tier worktree never pushes", () => {
  test("investigate tier's throwaway worktree is not pushable, so salvage reports no branch", async () => {
    const wt = await createReadWorktree(fx.repo, key());
    const output = await salvage(
      { ok: false, noOutput: true, error: "no structured output" },
      undefined,
      { cwd: fx.repo, tier: "investigate", brief: "brief", startMs: performance.now() },
      wt,
      undefined,
      () => {},
    );
    expect(output.outcome).toBe("salvaged");
    expect(output.branch).toBeUndefined();
  });
});

// ── GET /api/dispatch-schema ─────────────────────────────────────────────────────

describe("GET /api/dispatch-schema", () => {
  test("returns version, outcomes and JSON-Schema-shaped output/worker schemas", async () => {
    const res = await dispatchSchemaRoutes.handle(
      new Request("http://localhost/api/dispatch-schema"),
    );
    const body = (await res.json()) as {
      ok: boolean;
      version: number;
      outcomes: string[];
      output: { type: string; properties: Record<string, unknown> };
      worker: { investigate: unknown; author: unknown; implement: unknown };
    };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(DISPATCH_SCHEMA_VERSION);
    expect(body.outcomes.toSorted()).toEqual([...DISPATCH_OUTCOMES].toSorted());
    expect(body.outcomes).toHaveLength(11);
    expect(body.output.type).toBe("object");
    expect(Object.keys(body.output.properties)).toContain("outcome");
    expect(Object.keys(body.output.properties)).toContain("schemaVersion");
    expect(body.worker.investigate).toBeTruthy();
    expect(body.worker.author).toBeTruthy();
    expect(body.worker.implement).toBeTruthy();
  });
});
