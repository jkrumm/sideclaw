// `review`'s scope-expression parsing (`scopeDiffArgs`/`gitDiffCommand`/`validateScope`) plus
// the `pr`/`branch` ref-mode addition: the mutual-exclusion and scope-rejection guards in
// `runReview`, the branch-name validator, and the worktree-checkout-plus-diff helper
// (`checkoutRefDiff`) that mode is actually built on. `origin` is a local bare repo (same
// fixture dispatch's own tests use), which is what makes the checkout+diff half testable
// without a network call or a GitHub credential — `resolveReviewBase`'s own GitHub-identity
// half stays untested here for the same reason `pr_opened` is untested in
// dispatch-outcome.test.ts: no seam exists to fake `octokit().repos.get` without one.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import {
  assertSafeDefaultBranch,
  checkoutRefDiff,
  gitDiffCommand,
  REVIEW_OUTCOMES,
  REVIEW_SCHEMA_VERSION,
  runReview,
  scopeDiffArgs,
  validateBranchRef,
  validateScope,
} from "../server/jobs/handlers/review.ts";
import { removeWorktree } from "../server/jobs/handlers/dispatch-git.ts";
import { reviewSchemaRoutes } from "../server/routes/review-schema.ts";
import { Fixture, git, makeFixture } from "./git-fixture.ts";

let fx: Fixture;

beforeEach(async () => {
  fx = await makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

function key(): string {
  return randomUUID();
}

// ── scopeDiffArgs / gitDiffCommand ──────────────────────────────────────────────

describe("scopeDiffArgs", () => {
  test("an explicit range passes through unchanged", () => {
    expect(scopeDiffArgs("main..HEAD")).toBe("main..HEAD");
  });

  test("a path-shaped scope (leading slash) becomes a `-- <path>` filter", () => {
    expect(scopeDiffArgs("/abs/path/file.ts")).toBe("-- /abs/path/file.ts");
  });

  test("a path-shaped scope (contains a dot) becomes a `-- <path>` filter", () => {
    expect(scopeDiffArgs("server/index.ts")).toBe("-- server/index.ts");
  });

  test("a bare ref becomes the range up to HEAD, not a single-commit `git show`", () => {
    expect(scopeDiffArgs("HEAD~3")).toBe("HEAD~3 HEAD");
  });
});

describe("gitDiffCommand", () => {
  test('"uncommitted" diffs cached, falls back to unstaged, and splices in untracked files', () => {
    const cmd = gitDiffCommand("uncommitted");
    expect(cmd).toContain("git diff --cached");
    expect(cmd).toContain("ls-files --others");
  });

  test('"head" reviews the last commit via `git show HEAD`', () => {
    expect(gitDiffCommand("head")).toBe("git show HEAD");
  });

  test("a range/ref scope falls through to a plain `git diff`", () => {
    expect(gitDiffCommand("HEAD~2")).toBe("git diff HEAD~2 HEAD");
  });
});

// ── validateScope / validateBranchRef ───────────────────────────────────────────

describe("validateScope", () => {
  test("uncommitted/head/ranges/paths are all accepted", () => {
    expect(() => validateScope("uncommitted")).not.toThrow();
    expect(() => validateScope("head")).not.toThrow();
    expect(() => validateScope("main..HEAD")).not.toThrow();
    expect(() => validateScope("HEAD~3")).not.toThrow();
  });

  test("shell metacharacters are refused", () => {
    expect(() => validateScope("HEAD; rm -rf /")).toThrow(/unsafe characters/);
    expect(() => validateScope("$(whoami)")).toThrow(/unsafe characters/);
  });
});

describe("validateBranchRef", () => {
  test("an ordinary branch name is accepted", () => {
    expect(() => validateBranchRef("feature/add-thing")).not.toThrow();
    expect(() => validateBranchRef("fix-123")).not.toThrow();
    expect(() => validateBranchRef("release-1.2.3")).not.toThrow();
  });

  test("empty is refused", () => {
    expect(() => validateBranchRef("")).toThrow();
  });

  test("a leading '-' is refused (flag injection)", () => {
    expect(() => validateBranchRef("--upload-pack=evil")).toThrow(/unsafe characters/);
  });

  test("'..' is refused (range/traversal syntax) even though a lone '.' is allowed", () => {
    expect(() => validateBranchRef("main..evil")).toThrow(/must not contain '\.\.'/);
  });

  test("a name over 200 characters is refused", () => {
    expect(() => validateBranchRef("a".repeat(201))).toThrow(/200 characters/);
  });

  // The three shapes an allowlist has to refuse that a blocklist of "no -, no .., no
  // whitespace" would not have caught — `branch` is spliced straight into `bash -c "git fetch
  // … refs/heads/${branch}:…"`.
  test("a shell command separator ('x;id') is refused", () => {
    expect(() => validateBranchRef("x;id")).toThrow(/unsafe characters/);
  });

  test("a command substitution ('$(id)') is refused", () => {
    expect(() => validateBranchRef("$(id)")).toThrow(/unsafe characters/);
  });

  test("a backtick command substitution is refused", () => {
    expect(() => validateBranchRef("`id`")).toThrow(/unsafe characters/);
  });
});

// ── runReview: pr/branch mutual exclusion and scope rejection ──────────────────
//
// Both checks happen before any git/network call, so they're reachable against a real repo
// with no fixture ceremony beyond `fx.repo` existing.

describe("runReview pr/branch input validation", () => {
  test("pr and branch together are refused", async () => {
    await expect(runReview({ cwd: fx.repo, pr: 1, branch: "main" })).rejects.toThrow(
      /mutually exclusive/,
    );
  });

  test("scope together with pr is refused", async () => {
    await expect(runReview({ cwd: fx.repo, pr: 1, scope: "head" })).rejects.toThrow(
      /scope.*is ignored/,
    );
  });

  test("scope together with branch is refused", async () => {
    await expect(runReview({ cwd: fx.repo, branch: "main", scope: "uncommitted" })).rejects.toThrow(
      /scope.*is ignored/,
    );
  });

  test("a malformed branch ref is refused before any fetch", async () => {
    await expect(runReview({ cwd: fx.repo, branch: "--evil" })).rejects.toThrow(
      /unsafe characters/,
    );
  });
});

// ── fetch-ref cleanup when the throw lands before `worktree` ever exists ────────
//
// `fetchReviewHead` creates `refs/sideclaw-review/<jobKey>` in the CALLER's live repo, then
// `resolveReviewBase` runs — which throws for `fx.repo` specifically, because the fixture's
// `origin` is a local bare repo, not GitHub. That's the exact ordering the leak needed: the
// fetch already landed the ref, the throw happens strictly before `worktree` is ever
// assigned, so a cleanup gated on `worktree` (the old code) never ran.

describe("fetch-ref cleanup on a throw before the worktree exists", () => {
  test("a throw in base resolution, after the fetch, still cleans up the private fetch ref", async () => {
    await git(["checkout", "-q", "-b", "feature-y"], fx.repo);
    fx.write("y.ts", "export const y = 1;\n");
    await fx.commit("add feature-y");
    await git(["push", "-q", "origin", "feature-y"], fx.repo);
    await git(["checkout", "-q", "master"], fx.repo);

    await expect(runReview({ cwd: fx.repo, branch: "feature-y" })).rejects.toThrow(
      /not a GitHub remote/,
    );

    const leftover = await git(
      ["for-each-ref", "--format=%(refname)", "refs/sideclaw-review"],
      fx.repo,
    );
    expect(leftover.trim()).toBe("");
  });
});

// ── assertSafeDefaultBranch — the GitHub-reported default branch never reaches a shell unvetted ──
//
// `identity.defaultBranch` comes back from the GitHub API, not from this process, and
// `resolveReviewBase` splices it straight into `bash -c` commands. Pure and synchronous, so
// this asserts the refusal happens with no shell/network call in play at all.

describe("assertSafeDefaultBranch", () => {
  test("an ordinary default branch is accepted", () => {
    expect(() =>
      assertSafeDefaultBranch({ owner: "jkrumm", repo: "fixture", defaultBranch: "main" }),
    ).not.toThrow();
  });

  test("a default branch shaped like a command substitution is refused", () => {
    expect(() =>
      assertSafeDefaultBranch({ owner: "jkrumm", repo: "fixture", defaultBranch: "main$(id)" }),
    ).toThrow(/refusing to use jkrumm\/fixture's default branch "main\$\(id\)"/);
  });
});

// ── checkoutRefDiff — the worktree-checkout-plus-diff helper ref mode is built on ──

describe("checkoutRefDiff", () => {
  test("checks out a fetched ref's OID and diffs it against base with base...HEAD", async () => {
    const baseOid = await git(["rev-parse", "master"], fx.repo);

    await git(["checkout", "-q", "-b", "feature-x"], fx.repo);
    fx.write("new-feature.ts", "export const featureFlag = true;\n");
    const headOid = await fx.commit("add feature-x");
    // Back to master so the live checkout isn't left mid-review.
    await git(["checkout", "-q", "master"], fx.repo);

    const jobKey = key();
    const { wt, diff, files } = await checkoutRefDiff(fx.repo, jobKey, headOid, baseOid);

    expect(existsSync(wt.path)).toBe(true);
    expect(files).toContain("new-feature.ts");
    expect(diff).toContain("new-feature.ts");
    expect(diff).toContain("featureFlag");
    expect(diff).toContain("new file mode");

    await removeWorktree(fx.repo, wt);
    expect(existsSync(wt.path)).toBe(false);
  });
});

// ── GET /api/review-schema ───────────────────────────────────────────────────────

describe("GET /api/review-schema", () => {
  test("returns version, outcomes and a JSON-Schema-shaped output", async () => {
    const res = await reviewSchemaRoutes.handle(new Request("http://localhost/api/review-schema"));
    const body = (await res.json()) as {
      ok: boolean;
      version: number;
      outcomes: string[];
      output: { type: string; properties: Record<string, unknown> };
    };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(REVIEW_SCHEMA_VERSION);
    expect(body.outcomes.toSorted()).toEqual([...REVIEW_OUTCOMES].toSorted());
    expect(body.output.type).toBe("object");
    expect(Object.keys(body.output.properties)).toContain("outcome");
    expect(Object.keys(body.output.properties)).toContain("schemaVersion");
  });
});
