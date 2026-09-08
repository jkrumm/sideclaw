// Preloaded before every test module (bunfig.toml → [test].preload), so both of these are
// in place before dispatch-git.ts is imported by anything.

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The suite imports the app logger transitively; without this every run appends to the
// running server's own ~/Library/Logs/sideclaw.jsonl.
process.env.LOG_LEVEL ??= "silent";

// Point the worktree root away from the real one for the entire run. `sweepStaleWorktrees`
// deletes EVERY directory under this root, on the stated assumption that only one instance
// of the server exists — a test process is a second one, and against the real root it would
// tear down a live episode's worktree mid-flight. Individual fixtures narrow this further to
// their own temp dir; this is the backstop for a test that forgets.
process.env.SIDECLAW_WORKTREE_ROOT ??= mkdtempSync(join(tmpdir(), "sideclaw-test-worktrees-"));

// Same reasoning, for the salvage bundles a discarded worktree can produce: a test process
// must never write into the real ~/.local/state/sideclaw/salvage/. Individual fixtures narrow
// this further to their own temp dir; this is the backstop for a test that forgets.
process.env.SIDECLAW_SALVAGE_ROOT ??= mkdtempSync(join(tmpdir(), "sideclaw-test-salvage-"));

// Same reasoning, for verdicts a `sensitive` dispatch withholds: a test process must never
// write into the real ~/.local/state/sideclaw/private-verdicts/.
process.env.SIDECLAW_PRIVATE_VERDICTS_ROOT ??= mkdtempSync(
  join(tmpdir(), "sideclaw-test-private-verdicts-"),
);

// The job store opens its sqlite file at import, and the agents/overview suites import it
// transitively — without this every test run reads (and prunes) the live server's queue.
process.env.SIDECLAW_JOBS_DB ??= join(
  mkdtempSync(join(tmpdir(), "sideclaw-test-jobs-")),
  "jobs.db",
);
