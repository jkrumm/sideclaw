import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Next to jobs.db (server/jobs/store.ts), NOT /tmp. macOS's periodic cleanup
// sweeps /tmp files untouched for 3+ days; measured on the mini 2026-07-31,
// `lsof` showed this DB held open as an UNLINKED inode while `ls /tmp/sideclaw.db`
// returned No such file. The table below is genuinely ephemeral (dropped every
// startup, 2h TTL), so nothing durable was lost — but an unlinked SQLite file is
// still a file the process can never checkpoint, back up, or inspect from
// outside, and it grows without a path to reclaim it.
const DB_PATH =
  process.env.SIDECLAW_DB ?? join(homedir(), ".local", "share", "sideclaw", "sideclaw.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Drop and recreate on schema change (ephemeral data — completed_tasks is a
// 2-hour scratch view, never a durable record)
db.run("DROP TABLE IF EXISTS completed_tasks");
db.run(`
  CREATE TABLE completed_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_path TEXT NOT NULL,
    content TEXT NOT NULL,
    preview TEXT NOT NULL,
    kind TEXT NOT NULL,
    is_running INTEGER NOT NULL DEFAULT 1,
    completed_at INTEGER NOT NULL
  )
`);

export interface CompletedTask {
  id: number;
  repo_path: string;
  content: string;
  preview: string;
  kind: "task" | "slash";
  is_running: number;
  completed_at: number;
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const MAX_PER_REPO = 4; // 3 done + 1 running

export function insertCompleted(
  repoPath: string,
  task: { content: string; preview: string; kind: "task" | "slash" },
): void {
  const now = Date.now();

  // Previous running task becomes done
  db.run("UPDATE completed_tasks SET is_running = 0 WHERE repo_path = ? AND is_running = 1", [
    repoPath,
  ]);

  // Insert new task as running
  db.run(
    "INSERT INTO completed_tasks (repo_path, content, preview, kind, is_running, completed_at) VALUES (?, ?, ?, ?, 1, ?)",
    [repoPath, task.content, task.preview, task.kind, now],
  );

  // Trim to MAX_PER_REPO per repo (keep newest)
  db.run(
    `DELETE FROM completed_tasks WHERE repo_path = ? AND id NOT IN (
      SELECT id FROM completed_tasks WHERE repo_path = ? ORDER BY completed_at DESC LIMIT ?
    )`,
    [repoPath, repoPath, MAX_PER_REPO],
  );
}

/** Mark all running tasks as done for a repo (queue emptied → no more work). */
export function markAllDone(repoPath: string): void {
  db.run("UPDATE completed_tasks SET is_running = 0 WHERE repo_path = ? AND is_running = 1", [
    repoPath,
  ]);
}

export function getCompleted(repoPath: string): CompletedTask[] {
  db.run("DELETE FROM completed_tasks WHERE completed_at < ?", [Date.now() - TWO_HOURS_MS]);

  return db
    .query<CompletedTask, [string]>(
      "SELECT * FROM completed_tasks WHERE repo_path = ? ORDER BY completed_at DESC LIMIT ?",
    )
    .all(repoPath, MAX_PER_REPO as unknown as string);
}
