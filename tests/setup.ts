// Preloaded before every test module (bunfig.toml → [test].preload), so both of these are
// in place before dispatch-git.ts is imported by anything.

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The suite imports the app logger transitively; without this every run appends to the
// running server's own /tmp/sideclaw.jsonl.
process.env.LOG_LEVEL ??= "silent";

// Point the worktree root away from the real one for the entire run. `sweepStaleWorktrees`
// deletes EVERY directory under this root, on the stated assumption that only one instance
// of the server exists — a test process is a second one, and against the real root it would
// tear down a live episode's worktree mid-flight. Individual fixtures narrow this further to
// their own temp dir; this is the backstop for a test that forgets.
process.env.SIDECLAW_WORKTREE_ROOT ??= mkdtempSync(join(tmpdir(), "sideclaw-test-worktrees-"));
