// The `implement` tier's in-place workspace mode: the episode edits the repo's LIVE
// checkout, the handler creates no branch/commit/push/PR, and the change set is attributed
// against a pre-episode snapshot so the owner's own uncommitted work is never credited to
// (or blamed on) the episode. Real temp git repos via tests/git-fixture.ts, same as the
// worktree tests; no network, no worker session — everything here goes through the
// handler-side seams (`runDispatch` refusals, `snapshotInPlace`, `inPlaceChangedFiles`,
// `finishInPlace`).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  assertInPlaceAllowed,
  DISPATCH_OUTCOMES,
  DISPATCH_SCHEMA_VERSION,
  finishInPlace,
  releaseInPlaceLock,
  runDispatch,
  tryAcquireInPlaceLock,
} from "../server/jobs/handlers/dispatch.ts";
import { inPlaceChangedFiles, snapshotInPlace } from "../server/jobs/handlers/dispatch-git.ts";
import { SessionCancelledError } from "../server/mcp/session-runner.ts";
import { git as fixtureGit, run as fixtureRun, Fixture, makeFixture } from "./git-fixture.ts";

/** Same seam tests/jobs-recover-dispatch.test.ts relies on: setup.ts points this at a
 *  throwaway sqlite file for the whole run. */
function dbPath(): string {
  const p = process.env.SIDECLAW_JOBS_DB;
  if (!p) throw new Error("SIDECLAW_JOBS_DB not set — tests/setup.ts should have set it");
  return p;
}

let fx: Fixture;

beforeEach(async () => {
  fx = await makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

async function passingCheck() {
  return { passed: true as const, steps: [], summary: "stub: passed" };
}

// A real AWS access key id shape — assembled at call time so no credential-shaped literal
// sits in this file (the same reason dispatch-outcome.test.ts does it: the added-line scan
// this suite exercises runs on test diffs too).
const SECRET_BODY = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");

// ── Refusals — before anything runs ─────────────────────────────────────────────

describe("assertInPlaceAllowed", () => {
  test("allows implement with sensitive: false", () => {
    expect(() => assertInPlaceAllowed("implement", false)).not.toThrow();
  });

  test("refuses every other tier", () => {
    for (const tier of ["investigate", "author"] as const) {
      expect(() => assertInPlaceAllowed(tier, false)).toThrow(/dispatch refused:.*in-place/);
    }
  });

  test("refuses sensitive: true even at implement", () => {
    expect(() => assertInPlaceAllowed("implement", true)).toThrow(/dispatch refused:.*in-place/);
  });
});

describe("runDispatch — in-place refusals before anything runs", () => {
  test("in-place with tier investigate throws and creates no worktree or branch", async () => {
    try {
      await expect(
        runDispatch({ cwd: fx.repo, brief: "b", tier: "investigate", workspace: "in-place" }),
      ).rejects.toThrow(/dispatch refused:.*in-place/);
      expect(await fx.linkedWorktrees()).toEqual([]);
      expect(await fx.localBranches()).toEqual(["master"]);
    } finally {
      releaseInPlaceLock(fx.repo);
    }
  });

  test("in-place with sensitive: true throws before any worktree exists", async () => {
    try {
      // The sensitive tier refusal fires before the workspace check (both run before
      // anything is created); either message proves the episode never ran.
      await expect(
        runDispatch({
          cwd: fx.repo,
          brief: "b",
          tier: "implement",
          sensitive: true,
          workspace: "in-place",
        }),
      ).rejects.toThrow(/refused/);
      expect(await fx.linkedWorktrees()).toEqual([]);
    } finally {
      releaseInPlaceLock(fx.repo);
    }
  });

  test("a second in-place submission for the same repo while one holds the lock is refused", async () => {
    const first = tryAcquireInPlaceLock(fx.repo, "job-first");
    try {
      expect(first.ok).toBe(true);
      await expect(
        runDispatch({ cwd: fx.repo, brief: "b", tier: "implement", workspace: "in-place" }),
      ).rejects.toThrow(/already running in this repo \(job job-first\)/);
    } finally {
      releaseInPlaceLock(fx.repo);
    }
  });

  test("the lock is per-repo — a different repo is not refused", async () => {
    const other = await makeFixture();
    try {
      expect(tryAcquireInPlaceLock(fx.repo, "job-a").ok).toBe(true);
      expect(tryAcquireInPlaceLock(other.repo, "job-b").ok).toBe(true);
    } finally {
      releaseInPlaceLock(fx.repo);
      releaseInPlaceLock(other.repo);
      other.cleanup();
    }
  });
});

// ── Snapshot and change-set attribution — the owner's work is never the episode's ──

describe("snapshotInPlace / inPlaceChangedFiles", () => {
  test("a clean tree snapshots HEAD with no stash commit and no untracked files", async () => {
    const snap = await snapshotInPlace(fx.repo);
    expect(snap.headOid).toBe(await fixtureGit(["rev-parse", "HEAD"], fx.repo));
    expect(snap.branch).toBe("master");
    expect(snap.stashOid).toBe("");
    expect(snap.untracked).toEqual([]);
  });

  test("pre-existing dirty and untracked files are snapshot, not refusal", async () => {
    fx.write("owner-dirty.txt", "owner's uncommitted work\n");
    fx.write("owner-untracked.txt", "owner's untracked scratch\n");
    await fixtureGit(["add", "owner-dirty.txt"], fx.repo);

    const snap = await snapshotInPlace(fx.repo);
    // `stash create` captures the dirty state as a commit-ish without touching the tree.
    expect(snap.stashOid).not.toBe("");
    expect(snap.untracked).toContain("owner-untracked.txt");

    // The episode edits its own file and adds its own new one.
    fx.write("episode-edit.ts", "export const changed = true;\n");
    fx.write("episode-new.txt", "new file\n");
    await fixtureGit(["add", "episode-edit.ts"], fx.repo);

    const changed = await inPlaceChangedFiles(fx.repo, snap);
    expect(changed).toEqual(["episode-edit.ts", "episode-new.txt"]);
    expect(changed).not.toContain("owner-dirty.txt");
    expect(changed).not.toContain("owner-untracked.txt");
  });

  test("a tracked-file edit is attributed even when nothing was staged", async () => {
    const snap = await snapshotInPlace(fx.repo);
    const app = readFileSync(join(fx.repo, "src/app.ts"), "utf8");
    writeFileSync(join(fx.repo, "src/app.ts"), app + "export const v20 = 20;\n");
    const changed = await inPlaceChangedFiles(fx.repo, snap);
    expect(changed).toEqual(["src/app.ts"]);
  });

  test("the snapshot never mutates the tree — stash list and index untouched", async () => {
    fx.write("dirty.txt", "work in progress\n");
    const before = await fixtureGit(["status", "--porcelain"], fx.repo);
    await snapshotInPlace(fx.repo);
    const after = await fixtureGit(["status", "--porcelain"], fx.repo);
    expect(after).toBe(before);
    expect(await fixtureGit(["stash", "list"], fx.repo)).toBe("");
  });

  test("a failing `git stash create` (mid-merge conflict) throws rather than being read as a clean tree", async () => {
    // Measured shape: `git stash create` exits non-zero ("Cannot save the current index
    // state") when the index carries unresolved conflicts. Built by merging two branches that
    // both touch the same line — `fixtureGit` throws on ANY non-zero exit, including the
    // conflicting merge itself, so the merge step uses the raw, non-throwing `run` helper.
    await fixtureGit(["checkout", "-qb", "feature"], fx.repo);
    fx.write("src/app.ts", "export const conflict = 1;\n");
    await fixtureGit(["add", "-A"], fx.repo);
    await fixtureGit(["commit", "-qm", "feature change"], fx.repo);
    await fixtureGit(["checkout", "-q", "master"], fx.repo);
    fx.write("src/app.ts", "export const conflict = 2;\n");
    await fixtureGit(["add", "-A"], fx.repo);
    await fixtureGit(["commit", "-qm", "master change"], fx.repo);
    const merge = await fixtureRun(["git", "merge", "feature", "-q"], fx.repo);
    expect(merge.code).not.toBe(0); // the conflict is the point of this fixture

    await expect(snapshotInPlace(fx.repo)).rejects.toThrow(/git stash create failed/);
  });
});

// ── finishInPlace — the handler-side outcome logic ──────────────────────────────

describe("finishInPlace", () => {
  test("no changes → applied_in_place with an empty change set", async () => {
    const snap = await snapshotInPlace(fx.repo);
    const result = await finishInPlace(fx.repo, snap, () => {}, {
      runCheckFn: passingCheck,
    });
    expect(result.outcome).toBe("applied_in_place");
    expect(result.changedFiles).toEqual([]);
    expect(result.note).toMatch(/Nothing was changed/);
  });

  test("edits are reported uncommitted, no branch is created, no commit is made", async () => {
    const snap = await snapshotInPlace(fx.repo);
    fx.write("episode.txt", "the episode's work\n");
    const result = await finishInPlace(fx.repo, snap, () => {}, {
      runCheckFn: passingCheck,
    });
    expect(result.outcome).toBe("applied_in_place");
    expect(result.changedFiles).toEqual(["episode.txt"]);
    expect(result.note).toMatch(/UNCOMMITTED/);
    expect(result.note).toContain("episode.txt");
    // No commit was created and HEAD did not move.
    expect(await fixtureGit(["status", "--porcelain"], fx.repo)).toContain("?? episode.txt");
    expect(await fixtureGit(["rev-parse", "HEAD"], fx.repo)).toBe(snap.headOid);
    expect(await fx.localBranches()).toEqual(["master"]);
    expect(Object.keys(await fx.originRefs())).toEqual(["master"]);
  });

  test("a failing check is reported in the note, and the outcome stays applied_in_place", async () => {
    const snap = await snapshotInPlace(fx.repo);
    fx.write("episode.txt", "the episode's work\n");
    const result = await finishInPlace(fx.repo, snap, () => {}, {
      runCheckFn: async () => ({
        passed: false as const,
        steps: [{ name: "test", passed: false as const, errors: ["1 failing"] }],
        summary: "1/1 steps failed: test",
      }),
    });
    expect(result.outcome).toBe("applied_in_place");
    expect(result.note).toMatch(/checks FAILED/);
    expect(result.note).toMatch(/1\/1 steps failed: test/);
  });

  test("a CI-surface edit is a prominent warning, not a discard", async () => {
    const snap = await snapshotInPlace(fx.repo);
    fx.write(".github/workflows/evil.yml", "on: push\n");
    const result = await finishInPlace(fx.repo, snap, () => {}, {
      runCheckFn: passingCheck,
    });
    expect(result.outcome).toBe("applied_in_place");
    expect(result.changedFiles).toContain(".github/workflows/evil.yml");
    expect(result.note).toMatch(/WARNING: .*CI execution surface/);
  });

  test("a GitLab CI-surface edit is a prominent warning too", async () => {
    const snap = await snapshotInPlace(fx.repo);
    fx.write(".gitlab-ci.yml", "stages: [build]\n");
    const result = await finishInPlace(fx.repo, snap, () => {}, {
      runCheckFn: passingCheck,
    });
    expect(result.outcome).toBe("applied_in_place");
    expect(result.changedFiles).toContain(".gitlab-ci.yml");
    expect(result.note).toMatch(/WARNING: .*CI execution surface/);
  });

  test("a secret-shaped added line is a warning naming the pattern", async () => {
    const snap = await snapshotInPlace(fx.repo);
    fx.write("episode.txt", `${SECRET_BODY}\n`);
    const result = await finishInPlace(fx.repo, snap, () => {}, {
      runCheckFn: passingCheck,
    });
    expect(result.outcome).toBe("applied_in_place");
    expect(result.note).toMatch(/WARNING: .*AWS access key id/);
  });

  test("pre-existing secret-shaped text in the owner's dirty diff is NOT the episode's warning", async () => {
    // The owner's uncommitted edit carries a secret before the episode runs; the snapshot
    // base contains it, so it is not an ADDED line of the episode's change set.
    fx.write("owner.txt", `${SECRET_BODY}\n`);
    await fixtureGit(["add", "owner.txt"], fx.repo);
    const snap = await snapshotInPlace(fx.repo);
    fx.write("episode.txt", "harmless change\n");
    const result = await finishInPlace(fx.repo, snap, () => {}, {
      runCheckFn: passingCheck,
    });
    expect(result.note).not.toMatch(/AWS access key id/);
  });

  test("a secret already committed in a file the episode edits is NOT the episode's warning", async () => {
    fx.write("config.txt", `${SECRET_BODY}\n`);
    await fixtureGit(["add", "config.txt"], fx.repo);
    await fixtureGit(["commit", "-qm", "committed secret"], fx.repo);
    const snap = await snapshotInPlace(fx.repo);
    fx.write("config.txt", `${SECRET_BODY}\nharmless episode line\n`);
    const result = await finishInPlace(fx.repo, snap, () => {}, {
      runCheckFn: passingCheck,
    });
    expect(result.changedFiles).toEqual(["config.txt"]);
    expect(result.note).not.toMatch(/AWS access key id/);
  });

  test("a cancellation thrown by runCheckFn propagates rather than being reported as a failed check", async () => {
    const snap = await snapshotInPlace(fx.repo);
    fx.write("episode.txt", "the episode's work\n");
    await expect(
      finishInPlace(fx.repo, snap, () => {}, {
        jobId: "job-cancel-ip-1",
        runCheckFn: async () => {
          throw new SessionCancelledError("job-cancel-ip-1");
        },
      }),
    ).rejects.toBeInstanceOf(SessionCancelledError);
  });

  test("isCancelled observed true after a passing check also propagates", async () => {
    const snap = await snapshotInPlace(fx.repo);
    fx.write("episode.txt", "the episode's work\n");
    await expect(
      finishInPlace(fx.repo, snap, () => {}, {
        jobId: "job-cancel-ip-2",
        isCancelled: () => true,
        runCheckFn: passingCheck,
      }),
    ).rejects.toBeInstanceOf(SessionCancelledError);
  });

  test("a generic throw from the check tool is reported as a failed check, never re-thrown", async () => {
    const snap = await snapshotInPlace(fx.repo);
    fx.write("episode.txt", "the episode's work\n");
    const result = await finishInPlace(fx.repo, snap, () => {}, {
      runCheckFn: async () => {
        throw new Error("check tool exploded");
      },
    });
    expect(result.outcome).toBe("applied_in_place");
    expect(result.note).toMatch(/checks FAILED/);
    expect(result.note).toMatch(/check tool exploded/);
  });

  test("a check that reformats an untouched tracked file is reflected in the post-check changedFiles", async () => {
    const snap = await snapshotInPlace(fx.repo);
    fx.write("episode.txt", "the episode's work\n");
    const result = await finishInPlace(fx.repo, snap, () => {}, {
      // Stands in for the repo's own `format` script rewriting a file the episode never
      // touched — this is exactly why the change set is computed AFTER the check runs, not
      // before it.
      runCheckFn: async () => {
        writeFileSync(join(fx.repo, "README.md"), "# fixture (reformatted)\n");
        return { passed: true as const, steps: [], summary: "stub: formatted" };
      },
    });
    expect(result.changedFiles).toContain("README.md");
    expect(result.changedFiles).toContain("episode.txt");
  });

  test("HEAD moving during the episode (a worker that committed anyway) is a prominent WARNING", async () => {
    const snap = await snapshotInPlace(fx.repo);
    fx.write("episode.txt", "the episode's work\n");
    await fixtureGit(["add", "-A"], fx.repo);
    await fixtureGit(["commit", "-qm", "a worker committed despite the prompt"], fx.repo);
    const result = await finishInPlace(fx.repo, snap, () => {}, { runCheckFn: passingCheck });
    expect(result.note).toMatch(/WARNING: HEAD\/branch moved during the episode/);
    expect(result.note).toContain(snap.headOid.slice(0, 12));
  });

  test("a secret hit forces forceHuman: true", async () => {
    const snap = await snapshotInPlace(fx.repo);
    fx.write("episode.txt", `${SECRET_BODY}\n`);
    const result = await finishInPlace(fx.repo, snap, () => {}, { runCheckFn: passingCheck });
    expect(result.forceHuman).toBe(true);
  });

  test("a clean change set is forceHuman: false", async () => {
    const snap = await snapshotInPlace(fx.repo);
    fx.write("episode.txt", "harmless change\n");
    const result = await finishInPlace(fx.repo, snap, () => {}, { runCheckFn: passingCheck });
    expect(result.forceHuman).toBe(false);
  });
});

// ── The outcome enum and schema version ─────────────────────────────────────────

describe("applied_in_place in the published schema", () => {
  test("DISPATCH_OUTCOMES carries it and the version was bumped", () => {
    expect(DISPATCH_OUTCOMES).toContain("applied_in_place");
    expect(DISPATCH_SCHEMA_VERSION).toBe(3);
  });
});

// ── Boot recovery — an in-place row is marked interrupted, never resumed ────────
//
// The chosen recovery mode (the brief allowed either): an in-place episode has no worktree
// to reconstruct and its snapshot was process-local, so `recover()` marks the row
// `interrupted` instead of resuming. Same seeding technique as
// tests/jobs-recover-dispatch.test.ts — a second sqlite connection writes the on-disk shape
// a real restart leaves.

describe("recover() — an in-place dispatch row", () => {
  test("is marked interrupted even with a session id and existing path", async () => {
    const { __resetForTests, createJob, getJob, initJobStore } =
      await import("../server/jobs/store.ts");
    try {
      const created = createJob("dispatch", {
        cwd: fx.repo,
        tier: "implement",
        workspace: "in-place",
      });
      const seed = new Database(dbPath());
      seed.run("PRAGMA busy_timeout = 5000");
      seed.run(
        "UPDATE jobs SET status = 'running', started_at = ?, attempts = 1, session_id = ?, worktree_meta = ? WHERE id = ?",
        [
          Date.now(),
          "worker-session-in-place",
          JSON.stringify({ path: fx.repo, workspace: "in-place" }),
          created.id,
        ],
      );
      seed.close();

      initJobStore({ executor: () => new Promise<unknown>(() => {}) });

      const after = getJob(created.id);
      expect(after?.status).toBe("interrupted");
      expect(after?.error).toBe("HTTP server restarted while job was running");
    } finally {
      __resetForTests();
    }
  });
});
