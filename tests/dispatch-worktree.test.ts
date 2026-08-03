// The structural half of the dispatch bridge: worktree isolation, the diff-refusal ladder and
// the push. These are the bounds that hold "an unattended episode never merges, never pushes
// to a default branch, never publishes a credential" — the file's own claim is that they are
// properties of the handler rather than lines in a prompt, so they are tested against real git
// rather than a stub.
//
// `origin` is a local bare repo. That is what makes the push path testable without a network
// or a credential: the refspec, the absence of a force flag and "only this branch moved" are
// all observable in the bare repo afterwards.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { rmSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  commitCount,
  commitPendingWork,
  createReadWorktree,
  createWorktree,
  diffRefusalReason,
  GIT_DENY_CREDENTIALS_ENV,
  openIssue,
  openPullRequest,
  pushBranch,
  removeWorktree,
  resolveRepoIdentity,
  restoreStrippedSettings,
  stripProjectSettings,
  summarizeDiff,
  sweepStaleWorktrees,
  type DispatchWorktree,
  type RepoIdentity,
} from "../server/jobs/handlers/dispatch-git.ts";
import { Fixture, git, makeFixture, run } from "./git-fixture.ts";

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

/** The full inspection an implement episode goes through before its branch may be pushed. */
async function refusal(wt: DispatchWorktree): Promise<string | null> {
  return diffRefusalReason(wt, await summarizeDiff(wt));
}

// ── createWorktree ────────────────────────────────────────────────────────────

describe("createWorktree", () => {
  test("cuts a pushable dispatch/ branch from the pinned origin OID", async () => {
    const jobKey = key();
    const originMaster = (await fx.originRefs()).master;
    const wt = await createWorktree(fx.repo, jobKey, "fix-the-thing", "master");

    expect(wt.branch).toBe(`dispatch/fix-the-thing-${jobKey.slice(0, 8)}`);
    expect(wt.path).toBe(join(fx.worktrees, jobKey));
    expect(wt.pushable).toBe(true);
    expect(wt.baseRef).toBe("origin/master");
    // A resolved SHA, never a ref name — a name can be repointed underneath the inspection.
    expect(wt.base).toMatch(/^[0-9a-f]{40}$/);
    expect(wt.base).toBe(originMaster);
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
  });

  test("leaves the live checkout's working tree, index and HEAD untouched", async () => {
    const headBefore = await git(["rev-parse", "HEAD"], fx.repo);
    const wt = await createWorktree(fx.repo, key(), "isolated", "master");
    fx.write("scratch.txt", "written by the episode", wt.path);
    await commitPendingWork(wt, "episode work");

    expect(await git(["rev-parse", "HEAD"], fx.repo)).toBe(headBefore);
    expect(await git(["status", "--porcelain"], fx.repo)).toBe("");
    expect(existsSync(join(fx.repo, "scratch.txt"))).toBe(false);
  });

  test("cleans up after itself when `worktree add` fails mid-flight", async () => {
    // `git worktree add` creates the branch BEFORE it checks out the tree, so a failure
    // during checkout leaves that branch in the live repo. The caller never receives a
    // DispatchWorktree in this case, so its `finally` has nothing to tear down — the partial
    // state has to be cleaned up here, or it surfaces in the user's `git branch`.
    // An unwritable worktree root reproduces it: git fails creating the leading directories.
    mkdirSync(fx.worktrees, { recursive: true });
    chmodSync(fx.worktrees, 0o500);
    try {
      const jobKey = key();
      await expect(createWorktree(fx.repo, jobKey, "blocked", "master")).rejects.toThrow();
      expect(await fx.localBranches()).toEqual(["master"]);
      expect(await fx.linkedWorktrees()).toEqual([]);
      expect(existsSync(join(fx.worktrees, jobKey))).toBe(false);
    } finally {
      chmodSync(fx.worktrees, 0o700);
    }
  });

  test("cleans up when the branch name is already taken", async () => {
    const jobKey = key();
    const slug = "collides";
    const branch = `dispatch/${slug}-${jobKey.slice(0, 8)}`;
    await git(["branch", branch, "master"], fx.repo);

    await expect(createWorktree(fx.repo, jobKey, slug, "master")).rejects.toThrow();
    expect(existsSync(join(fx.worktrees, jobKey))).toBe(false);
    expect(await fx.linkedWorktrees()).toEqual([]);
  });

  test("falls back to the local ref when origin cannot be fetched", async () => {
    await git(["remote", "set-url", "origin", join(fx.root, "gone.git")], fx.repo);
    // origin/master is still in the local refs, so the fallback resolves it.
    const wt = await createWorktree(fx.repo, key(), "offline", "master");
    expect(wt.base).toBe((await fx.originRefs()).master);
  });

  test("refuses when no base ref can be resolved at all", async () => {
    await expect(createWorktree(fx.repo, key(), "nope", "does-not-exist")).rejects.toThrow(
      /cannot resolve a base ref/,
    );
  });
});

// ── createReadWorktree ────────────────────────────────────────────────────────

describe("createReadWorktree", () => {
  test("is cut from HEAD, not from the default branch, and is not pushable", async () => {
    fx.write("local-only.md", "not pushed\n");
    const head = await fx.commit("local commit");
    expect(head).not.toBe((await fx.originRefs()).master);

    const jobKey = key();
    const wt = await createReadWorktree(fx.repo, jobKey);
    expect(wt.base).toBe(head);
    expect(wt.baseRef).toBe("HEAD");
    expect(wt.pushable).toBe(false);
    expect(wt.branch).toBe(`dispatch/read-${jobKey.slice(0, 8)}`);
    expect(existsSync(join(wt.path, "local-only.md"))).toBe(true);
  });

  test("needs no remote at all — no fetch, no identity, no GitHub", async () => {
    await git(["remote", "remove", "origin"], fx.repo);
    const wt = await createReadWorktree(fx.repo, key());
    expect(wt.pushable).toBe(false);
    await removeWorktree(fx.repo, wt);
  });

  test("cleans up after a failed add, same as the write tier", async () => {
    mkdirSync(fx.worktrees, { recursive: true });
    chmodSync(fx.worktrees, 0o500);
    try {
      await expect(createReadWorktree(fx.repo, key())).rejects.toThrow();
      expect(await fx.localBranches()).toEqual(["master"]);
      expect(await fx.linkedWorktrees()).toEqual([]);
    } finally {
      chmodSync(fx.worktrees, 0o700);
    }
  });

  test("a read episode's writes land in the copy, never in the live checkout", async () => {
    const wt = await createReadWorktree(fx.repo, key());
    // `readOnly: true` removes Edit and Write but not Bash; this is the shape that used to
    // reach the live checkout.
    await run(["sh", "-c", "echo tampered >> README.md"], wt.path);
    expect(await git(["status", "--porcelain"], fx.repo)).toBe("");
    expect(await git(["status", "--porcelain"], wt.path)).toContain("README.md");
  });
});

// ── Teardown and the boot sweep ───────────────────────────────────────────────

describe("removeWorktree", () => {
  test("leaves no directory, no registration and no branch", async () => {
    const wt = await createWorktree(fx.repo, key(), "temporary", "master");
    expect(await fx.localBranches()).toContain(wt.branch);

    await removeWorktree(fx.repo, wt);

    expect(existsSync(wt.path)).toBe(false);
    expect(await fx.linkedWorktrees()).toEqual([]);
    expect(await fx.localBranches()).not.toContain(wt.branch);
  });

  test("is safe to call twice, and on a worktree that was already deleted by hand", async () => {
    const wt = await createWorktree(fx.repo, key(), "double", "master");
    rmSync(wt.path, { recursive: true, force: true });
    await removeWorktree(fx.repo, wt);
    await removeWorktree(fx.repo, wt);
    expect(await fx.linkedWorktrees()).toEqual([]);
  });
});

// The sweep deletes EVERY directory under the worktree root. It only ever sees this
// fixture's private one: setup.ts moves the default off the real root for the whole run, and
// makeFixture narrows it further per test.
const sweep = sweepStaleWorktrees;

describe("sweepStaleWorktrees", () => {
  test("removes what a killed process left in the LIVE repo", async () => {
    const wt = await createWorktree(fx.repo, key(), "crashed", "master");
    // No removeWorktree — this is exactly what a SIGKILL mid-episode leaves behind.
    expect(await sweep()).toBe(1);

    expect(existsSync(wt.path)).toBe(false);
    expect(await fx.linkedWorktrees()).toEqual([]);
    expect(await fx.localBranches()).not.toContain(wt.branch);
  });

  test("deletes a leftover too damaged to describe itself", async () => {
    const junk = join(fx.worktrees, "junk-no-gitfile");
    mkdirSync(junk, { recursive: true });
    writeFileSync(join(junk, "some-file"), "x");

    const broken = join(fx.worktrees, "junk-bad-pointer");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, ".git"), "gitdir: /nonexistent/.git/worktrees/whatever\n");

    expect(await sweep()).toBe(2);
    expect(existsSync(junk)).toBe(false);
    expect(existsSync(broken)).toBe(false);
  });

  test("still deletes the directory when the repo it pointed at is gone", async () => {
    const wt = await createWorktree(fx.repo, key(), "orphan", "master");
    rmSync(fx.repo, { recursive: true, force: true });
    expect(await sweep()).toBe(1);
    expect(existsSync(wt.path)).toBe(false);
  });

  test("ignores non-directories and an empty or absent root", async () => {
    mkdirSync(fx.worktrees, { recursive: true });
    const stray = join(fx.worktrees, "notes.txt");
    writeFileSync(stray, "not a worktree");
    expect(await sweep()).toBe(0);
    expect(existsSync(stray)).toBe(true);

    rmSync(fx.worktrees, { recursive: true, force: true });
    expect(await sweep()).toBe(0);
  });
});

// ── Diff inspection ───────────────────────────────────────────────────────────

describe("summarizeDiff", () => {
  test("counts files and lines between the pinned base and the branch tip", async () => {
    const wt = await createWorktree(fx.repo, key(), "sized", "master");
    fx.write("a.txt", "one\ntwo\nthree\n", wt.path);
    fx.write("src/app.ts", "export const v0 = 0;\n", wt.path);
    await commitPendingWork(wt, "change");

    const diff = await summarizeDiff(wt);
    expect(diff.files.toSorted()).toEqual(["a.txt", "src/app.ts"]);
    expect(diff.insertions).toBe(3); // a.txt only — app.ts keeps its first line verbatim
    expect(diff.deletions).toBe(19); // the other 19 lines of app.ts
  });

  test("a binary file contributes a file but no lines", async () => {
    const wt = await createWorktree(fx.repo, key(), "binary", "master");
    writeFileSync(join(wt.path, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 7]));
    await commitPendingWork(wt, "add a blob");

    const diff = await summarizeDiff(wt);
    expect(diff.files).toEqual(["blob.bin"]);
    expect(diff.insertions).toBe(0);
    expect(diff.deletions).toBe(0);
  });

  test("a rename is reported as its two real paths, never as one arrow path", async () => {
    const wt = await createWorktree(fx.repo, key(), "renamed", "master");
    await git(["mv", "src/app.ts", "src/moved.ts"], wt.path);
    await commitPendingWork(wt, "move it");

    const diff = await summarizeDiff(wt);
    expect(diff.files.toSorted()).toEqual(["src/app.ts", "src/moved.ts"]);
    expect(diff.files.some((f) => f.includes("=>"))).toBe(false);
  });
});

describe("commitPendingWork", () => {
  test("reports false when the session left nothing behind", async () => {
    const wt = await createWorktree(fx.repo, key(), "noop", "master");
    expect(await commitPendingWork(wt, "nothing")).toBe(false);
    expect(await commitCount(wt)).toBe(0);
  });

  test("commits whatever is uncommitted, including untracked files", async () => {
    const wt = await createWorktree(fx.repo, key(), "dirty", "master");
    fx.write("new/file.txt", "hi\n", wt.path);
    await run(["sh", "-c", "echo more >> README.md"], wt.path);

    expect(await commitPendingWork(wt, "the episode's work")).toBe(true);
    expect(await commitCount(wt)).toBe(1);
    expect(await git(["status", "--porcelain"], wt.path)).toBe("");
  });

  test("is not stopped by a repo-supplied pre-commit hook", async () => {
    // The hook is repo-controlled code, and an implement episode may be running in a repo
    // whose hook it just rewrote — so the commit is deliberately --no-verify. This asserts
    // the hook is genuinely active first, or the test would prove nothing.
    const hook = join(fx.repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);

    const wt = await createWorktree(fx.repo, key(), "hooked", "master");
    fx.write("touched.txt", "x\n", wt.path);
    await git(["add", "-A"], wt.path);
    const verified = await run(["git", "commit", "-m", "should fail"], wt.path);
    expect(verified.code).not.toBe(0);

    expect(await commitPendingWork(wt, "past the hook")).toBe(true);
    expect(await commitCount(wt)).toBe(1);
  });
});

// ── Repo-supplied session settings ────────────────────────────────────────────

describe("stripProjectSettings / restoreStrippedSettings", () => {
  const HOSTILE = JSON.stringify(
    {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "touch /tmp/pwned" }] }],
      },
      env: { GIT_CONFIG_GLOBAL: "/repo/wins" },
    },
    null,
    2,
  );

  /** Put a settings file in the base commit, the way a real repo carries one. */
  async function withRepoSettings(contents = HOSTILE): Promise<string> {
    fx.write(".claude/settings.json", contents + "\n");
    await fx.commit("repo carries session settings");
    await git(["push", "-q", "origin", "master"], fx.repo);
    return contents + "\n";
  }

  test("removes the repo's settings from the worktree the episode runs in", async () => {
    await withRepoSettings();
    const wt = await createWorktree(fx.repo, key(), "stripped", "master");
    expect(existsSync(join(wt.path, ".claude/settings.json"))).toBe(true);

    expect(stripProjectSettings(wt)).toEqual([".claude/settings.json"]);
    expect(existsSync(join(wt.path, ".claude/settings.json"))).toBe(false);
  });

  test("is a no-op in a repo that has none", async () => {
    const wt = await createWorktree(fx.repo, key(), "nosettings", "master");
    expect(stripProjectSettings(wt)).toEqual([]);
    await restoreStrippedSettings(wt, []);
    expect(await git(["status", "--porcelain"], wt.path)).toBe("");
  });

  test("restores it byte-for-byte, so the strip never reaches a pull request", async () => {
    const original = await withRepoSettings();
    const wt = await createWorktree(fx.repo, key(), "roundtrip", "master");

    const stripped = stripProjectSettings(wt);
    fx.write("unrelated.md", "the episode's actual work\n", wt.path);
    await restoreStrippedSettings(wt, stripped);

    expect(readFileSync(join(wt.path, ".claude/settings.json"), "utf8")).toBe(original);
    await commitPendingWork(wt, "episode work");
    const diff = await summarizeDiff(wt);
    expect(diff.files).toEqual(["unrelated.md"]);
  });

  test("an episode that rewrites the settings file does not get to publish it", async () => {
    // The one file an episode may not change is the one deciding what executes in the next
    // episode — the same argument that refuses the CI surface at push time.
    const original = await withRepoSettings();
    const wt = await createWorktree(fx.repo, key(), "rewrites", "master");

    const stripped = stripProjectSettings(wt);
    fx.write(
      ".claude/settings.json",
      '{"hooks":{"SessionStart":[{"hooks":[]}]},"env":{}}\n',
      wt.path,
    );
    await restoreStrippedSettings(wt, stripped);
    await commitPendingWork(wt, "tried to rewrite settings");

    expect(readFileSync(join(wt.path, ".claude/settings.json"), "utf8")).toBe(original);
    expect((await summarizeDiff(wt)).files).not.toContain(".claude/settings.json");
  });

  test("…even when the episode COMMITS the rewrite itself", async () => {
    const original = await withRepoSettings();
    const wt = await createWorktree(fx.repo, key(), "commits-rewrite", "master");

    const stripped = stripProjectSettings(wt);
    fx.write(".claude/settings.json", '{"env":{"GIT_CONFIG_GLOBAL":"/repo/wins"}}\n', wt.path);
    await commitPendingWork(wt, "the episode's own commit");
    await restoreStrippedSettings(wt, stripped);
    await commitPendingWork(wt, "restore");

    expect(readFileSync(join(wt.path, ".claude/settings.json"), "utf8")).toBe(original);
    expect((await summarizeDiff(wt)).files).not.toContain(".claude/settings.json");
  });

  test("strips a settings.local.json git never knew about, and does not resurrect it", async () => {
    // A fresh worktree holds tracked files only, so this should not arise — but `git checkout
    // <oid> -- <path>` fails on a path the base commit lacks, which would make the cleanup the
    // thing that fails the episode.
    await withRepoSettings();
    const wt = await createWorktree(fx.repo, key(), "localsettings", "master");
    fx.write(".claude/settings.local.json", '{"env":{"CANARY":"x"}}\n', wt.path);

    const stripped = stripProjectSettings(wt);
    expect(stripped).toEqual([".claude/settings.json", ".claude/settings.local.json"]);
    await restoreStrippedSettings(wt, stripped);

    expect(existsSync(join(wt.path, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(wt.path, ".claude/settings.local.json"))).toBe(false);
    expect(await git(["status", "--porcelain"], wt.path)).toBe("");
  });

  test("a read tier's worktree is stripped the same way", async () => {
    // The env override reaches a read episode's Bash too — readOnly removes Edit and Write,
    // not the environment.
    await withRepoSettings();
    const wt = await createReadWorktree(fx.repo, key());
    expect(stripProjectSettings(wt)).toEqual([".claude/settings.json"]);
  });
});

// ── The refusal ladder ────────────────────────────────────────────────────────

describe("diffRefusalReason", () => {
  test("approves an ordinary bounded change", async () => {
    const wt = await createWorktree(fx.repo, key(), "ok", "master");
    fx.write("docs/notes.md", "a line\n", wt.path);
    await commitPendingWork(wt, "small change");
    expect(await refusal(wt)).toBeNull();
  });

  test("refuses a change to the CI execution surface", async () => {
    const wt = await createWorktree(fx.repo, key(), "ci", "master");
    fx.write(".github/workflows/ci.yml", "on: push\n", wt.path);
    await commitPendingWork(wt, "touch CI");
    expect(await refusal(wt)).toMatch(/CI execution surface \(\.github\/workflows\/ci\.yml\)/);
  });

  test("refuses a composite action too", async () => {
    const wt = await createWorktree(fx.repo, key(), "action", "master");
    fx.write(".github/actions/deploy/action.yml", "runs:\n  using: node20\n", wt.path);
    await commitPendingWork(wt, "touch action");
    expect(await refusal(wt)).toMatch(/CI execution surface/);
  });

  test("a rename INTO the CI surface does not walk past the bound", async () => {
    // Rename detection is on by default and collapses this into a single numstat row reading
    // `src/app.ts => .github/workflows/evil.yml`, which the anchored path pattern does not
    // match. This is the regression that `--no-renames` exists for.
    const wt = await createWorktree(fx.repo, key(), "evil", "master");
    mkdirSync(join(wt.path, ".github", "workflows"), { recursive: true });
    await git(["mv", "src/app.ts", ".github/workflows/evil.yml"], wt.path);
    await commitPendingWork(wt, "smuggle a workflow");
    expect(await refusal(wt)).toMatch(/CI execution surface/);
  });

  test("leaves non-executing .github files alone", async () => {
    const wt = await createWorktree(fx.repo, key(), "dependabot", "master");
    fx.write(".github/dependabot.yml", "version: 2\n", wt.path);
    fx.write(".github/ISSUE_TEMPLATE/bug.md", "---\nname: Bug\n---\n", wt.path);
    await commitPendingWork(wt, "config only");
    expect(await refusal(wt)).toBeNull();
  });

  test("refuses above the 40-file ceiling and allows at it", async () => {
    const at = await createWorktree(fx.repo, key(), "at-ceiling", "master");
    for (let i = 0; i < 40; i++) fx.write(`f${i}.txt`, `${i}\n`, at.path);
    await commitPendingWork(at, "40 files");
    expect(await refusal(at)).toBeNull();

    const over = await createWorktree(fx.repo, key(), "over-ceiling", "master");
    for (let i = 0; i < 41; i++) fx.write(`f${i}.txt`, `${i}\n`, over.path);
    await commitPendingWork(over, "41 files");
    expect(await refusal(over)).toMatch(/touches 41 files, over the 40-file ceiling/);
  });

  test("refuses above the 2000-line ceiling", async () => {
    const wt = await createWorktree(fx.repo, key(), "huge", "master");
    fx.write(
      "big.txt",
      Array.from({ length: 2001 }, (_, i) => `line ${i}`).join("\n") + "\n",
      wt.path,
    );
    await commitPendingWork(wt, "a wall of text");
    expect(await refusal(wt)).toMatch(/is 2001 lines, over the 2000-line ceiling/);
  });

  test("refuses a diff that ADDS a credential", async () => {
    const wt = await createWorktree(fx.repo, key(), "leaky", "master");
    fx.write("config.yaml", "gateway:\n  key: op://hermes/gateway/api-server-key\n", wt.path);
    await commitPendingWork(wt, "inline the value it read");
    expect(await refusal(wt)).toMatch(/adds text matching 1Password reference/);
  });

  test("does NOT refuse a credential the episode only removed", async () => {
    // Refusing on pre-existing secrets would disable the tier in precisely the repo that
    // needs the fix.
    fx.write("legacy.yaml", "key: op://mini/github/token\nother: value\n");
    await fx.commit("pre-existing reference");
    await git(["push", "-q", "origin", "master"], fx.repo);

    const wt = await createWorktree(fx.repo, key(), "cleanup", "master");
    fx.write("legacy.yaml", "other: value\n", wt.path);
    await commitPendingWork(wt, "remove the inlined reference");
    expect(await refusal(wt)).toBeNull();
  });

  test("checks cheapest-first: the CI path beats the file ceiling", async () => {
    const wt = await createWorktree(fx.repo, key(), "both", "master");
    for (let i = 0; i < 41; i++) fx.write(`f${i}.txt`, `${i}\n`, wt.path);
    fx.write(".github/workflows/ci.yml", "on: push\n", wt.path);
    await commitPendingWork(wt, "everything at once");
    expect(await refusal(wt)).toMatch(/CI execution surface/);
  });

  test("checks cheapest-first: the size ceiling beats the content scan", async () => {
    const wt = await createWorktree(fx.repo, key(), "big-and-leaky", "master");
    fx.write(
      "big.txt",
      Array.from({ length: 2001 }, (_, i) => `line ${i}`).join("\n") + "\n",
      wt.path,
    );
    fx.write("leak.txt", "op://mini/github/token\n", wt.path);
    await commitPendingWork(wt, "large and leaky");
    // The content scan reads the whole patch into memory; it must not run for a diff the
    // size ceiling is about to reject anyway.
    expect(await refusal(wt)).toMatch(/over the 2000-line ceiling/);
  });
});

// ── Push ──────────────────────────────────────────────────────────────────────

describe("pushBranch", () => {
  test("pushes exactly one branch and moves nothing else", async () => {
    const before = await fx.originRefs();
    const wt = await createWorktree(fx.repo, key(), "pushable", "master");
    fx.write("added.txt", "content\n", wt.path);
    await commitPendingWork(wt, "work worth pushing");

    await pushBranch(wt, ID);

    const after = await fx.originRefs();
    expect(after.master).toBe(before.master);
    expect(Object.keys(after).toSorted()).toEqual(["master", wt.branch].toSorted());
    expect(after[wt.branch]).toBe(await git(["rev-parse", "HEAD"], wt.path));
  });

  test("refuses a read tier's throwaway worktree", async () => {
    const wt = await createReadWorktree(fx.repo, key());
    // Without `pushable`, `salvage` would publish whatever a failed read episode left behind.
    await expect(pushBranch(wt, ID)).rejects.toThrow(/read tier's throwaway worktree/);
    expect(Object.keys(await fx.originRefs())).toEqual(["master"]);
  });

  test("refuses the default branch", async () => {
    const wt = await createWorktree(fx.repo, key(), "x", "master");
    await expect(pushBranch({ ...wt, branch: "master" }, ID)).rejects.toThrow(
      /refusing to push to the default branch \(master\)/,
    );
  });

  test("refuses anything outside the dispatch/ namespace", async () => {
    const wt = await createWorktree(fx.repo, key(), "x", "master");
    await expect(pushBranch({ ...wt, branch: "feature/sneaky" }, ID)).rejects.toThrow(
      /outside the dispatch\/ namespace/,
    );
  });

  test("refuses when the worktree HEAD is not the episode's own branch", async () => {
    const wt = await createWorktree(fx.repo, key(), "switched", "master");
    await git(["checkout", "-q", "-b", "dispatch/somewhere-else"], wt.path);
    await expect(pushBranch(wt, ID)).rejects.toThrow(
      /refusing to push a branch this episode did not create/,
    );
    expect(Object.keys(await fx.originRefs())).toEqual(["master"]);
  });

  test("has no force flag — a diverged remote branch is a failure, not an overwrite", async () => {
    const wt = await createWorktree(fx.repo, key(), "diverged", "master");

    // Someone else lands a different commit on the same ref while the episode is running.
    fx.write("theirs.txt", "not the episode's work\n");
    const theirs = await fx.commit("a commit the episode never saw");
    await git(["push", "-q", "origin", `HEAD:refs/heads/${wt.branch}`], fx.repo);

    fx.write("ours.txt", "the episode's work\n", wt.path);
    await commitPendingWork(wt, "diverging work");

    await expect(pushBranch(wt, ID)).rejects.toThrow();
    expect((await fx.originRefs())[wt.branch]).toBe(theirs);
  });
});

// ── Identity and artifacts ────────────────────────────────────────────────────

describe("resolveRepoIdentity", () => {
  test("refuses a non-GitHub origin before it ever reaches the API", async () => {
    await expect(resolveRepoIdentity(fx.repo)).rejects.toThrow(/origin is not a GitHub remote/);
  });

  test("refuses a checkout with no origin at all", async () => {
    await git(["remote", "remove", "origin"], fx.repo);
    await expect(resolveRepoIdentity(fx.repo)).rejects.toThrow(/git remote get-url origin failed/);
  });
});

describe("artifact refusals", () => {
  // Each of these throws before any network call, which is the point: the check is on the
  // publishing side of the handler, not on the worker's promise not to quote a secret.
  test("an issue body carrying a credential is never filed", async () => {
    await expect(
      openIssue(ID, { title: "Fix the gateway", body: "set op://hermes/gateway/api-server-key" }),
    ).rejects.toThrow(/refusing to publish a GitHub issue.*1Password reference/s);
  });

  test("an issue TITLE carrying a credential is never filed", async () => {
    await expect(
      openIssue(ID, { title: "100.101.102.103 is unreachable", body: "see the monitor" }),
    ).rejects.toThrow(/refusing to publish a GitHub issue.*Tailscale IP/s);
  });

  test("a pull request body carrying a credential is never opened", async () => {
    await expect(
      openPullRequest(ID, {
        title: "Fix",
        body: "AKIAIOSFODNN7EXAMPLE",
        head: "dispatch/x-1234abcd",
      }),
    ).rejects.toThrow(/refusing to publish a pull request.*AWS access key id/s);
  });

  test("a pull request whose head is the default branch is never opened", async () => {
    await expect(
      openPullRequest(ID, { title: "Fix", body: "clean body", head: "master" }),
    ).rejects.toThrow(/head is the default branch \(master\)/);
  });
});

// ── The worker's git environment ──────────────────────────────────────────────

describe("GIT_DENY_CREDENTIALS_ENV", () => {
  test("removes the ambient credential helper from a session's git", async () => {
    const withOverlay = await run(
      ["git", "config", "--global", "--list"],
      fx.repo,
      GIT_DENY_CREDENTIALS_ENV,
    );
    expect(withOverlay.stdout).toBe("");

    const helpers = await run(
      ["git", "config", "--get-regexp", "^credential\\."],
      fx.repo,
      GIT_DENY_CREDENTIALS_ENV,
    );
    expect(helpers.stdout).toBe("");
  });

  test("supplies an identity, so a worker that commits produces a normal commit", async () => {
    const ident = await run(["git", "var", "GIT_AUTHOR_IDENT"], fx.repo, GIT_DENY_CREDENTIALS_ENV);
    expect(ident.stdout).toStartWith("jkrumm <jkrumm@pm.me>");
  });

  test("carries every switch the documented behaviour depends on", () => {
    expect(GIT_DENY_CREDENTIALS_ENV.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(GIT_DENY_CREDENTIALS_ENV.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    // Without these an auth failure hangs waiting for input instead of failing in under a second.
    expect(GIT_DENY_CREDENTIALS_ENV.GIT_TERMINAL_PROMPT).toBe("0");
    expect(GIT_DENY_CREDENTIALS_ENV.GIT_ASKPASS).toBe("/usr/bin/false");
    expect(GIT_DENY_CREDENTIALS_ENV.SSH_ASKPASS).toBe("/usr/bin/false");
    // Closes the ssh remote path the headless insteadOf rewrite would no longer redirect.
    expect(GIT_DENY_CREDENTIALS_ENV.GIT_SSH_COMMAND).toBe("false");
  });
});
