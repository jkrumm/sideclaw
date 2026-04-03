import { Database } from "bun:sqlite";

const db = new Database("/tmp/sideclaw.db");

// Drop and recreate on schema change (ephemeral data, /tmp is wiped on restart)
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
  db.run(
    "UPDATE completed_tasks SET is_running = 0 WHERE repo_path = ? AND is_running = 1",
    [repoPath],
  );

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
  db.run(
    "UPDATE completed_tasks SET is_running = 0 WHERE repo_path = ? AND is_running = 1",
    [repoPath],
  );
}

export function getCompleted(repoPath: string): CompletedTask[] {
  db.run("DELETE FROM completed_tasks WHERE completed_at < ?", [
    Date.now() - TWO_HOURS_MS,
  ]);

  return db
    .query<CompletedTask, [string]>(
      "SELECT * FROM completed_tasks WHERE repo_path = ? ORDER BY completed_at DESC LIMIT ?",
    )
    .all(repoPath, MAX_PER_REPO as unknown as string);
}
