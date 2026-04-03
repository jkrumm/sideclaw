import { existsSync } from "fs";
import { join } from "path";

// ── Constants ─────────────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? "/Users/johannes.krumm";
const PERSONAL_REPOS_PATH = process.env.PERSONAL_REPOS_PATH ?? "";
const PLUGIN_DIR = join(HOME, "SourceRoot/.claude");

// Prefer standalone install over cmux-bundled; fall back to PATH resolution
const CLAUDE_BIN = existsSync(join(HOME, ".local/bin/claude"))
  ? join(HOME, ".local/bin/claude")
  : "claude";

// ── Types ─────────────────────────────────────────────────────────────────────

export type JobStatus = "pending" | "running" | "pass" | "fail";

export interface ChainJob {
  id: string;
  skill: string;        // e.g. "/check" or "/pr create"
  worktreePath: string; // host path of target worktree
  status: JobStatus;
  output: string[];     // accumulated stdout lines
  startedAt: Date;
  completedAt?: Date;
  exitCode?: number;
}

type SseController = ReadableStreamDefaultController<string>;

// ── In-memory store ───────────────────────────────────────────────────────────

const jobs = new Map<string, ChainJob>();
const subscribers = new Map<string, Set<SseController>>();

function push(jobId: string, event: string, data: string) {
  const line = `event: ${event}\ndata: ${data}\n\n`;
  const subs = subscribers.get(jobId);
  if (subs) {
    for (const ctrl of subs) {
      try {
        ctrl.enqueue(line);
      } catch {
        // Client disconnected — remove silently
        subs.delete(ctrl);
      }
    }
  }
}

function close(jobId: string) {
  const subs = subscribers.get(jobId);
  if (subs) {
    for (const ctrl of subs) {
      try {
        ctrl.close();
      } catch {
        // already closed
      }
    }
    subscribers.delete(jobId);
  }
}

// ── Job execution ─────────────────────────────────────────────────────────────

function isPersonalRepo(worktreePath: string): boolean {
  return PERSONAL_REPOS_PATH ? worktreePath.startsWith(PERSONAL_REPOS_PATH) : false;
}

export async function startJob(skill: string, worktreePath: string): Promise<string> {
  const id = crypto.randomUUID();
  const job: ChainJob = {
    id,
    skill,
    worktreePath,
    status: "running",
    output: [],
    startedAt: new Date(),
  };
  jobs.set(id, job);

  // Run asynchronously — don't await
  void runJob(job);

  return id;
}

async function runJob(job: ChainJob) {
  const args: string[] = [
    "-p", job.skill,
    "--dangerously-skip-permissions",
  ];

  if (isPersonalRepo(job.worktreePath)) {
    args.push("--plugin-dir", PLUGIN_DIR);
  }

  const proc = Bun.spawn([CLAUDE_BIN, ...args], {
    cwd: job.worktreePath,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // Stream stdout
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    // Split into lines but preserve partial lines
    const lines = text.split("\n");
    for (const line of lines) {
      if (!line) continue;
      job.output.push(line);
      push(job.id, "output", JSON.stringify(line));
    }
  }

  // Capture stderr (don't stream — just collect for diagnostics)
  const stderrReader = proc.stderr.getReader();
  const stderrChunks: string[] = [];
  while (true) {
    const { done, value } = await stderrReader.read();
    if (done) break;
    stderrChunks.push(decoder.decode(value));
  }

  const exitCode = await proc.exited;
  job.exitCode = exitCode;
  job.completedAt = new Date();
  job.status = exitCode === 0 ? "pass" : "fail";

  // Add any stderr as diagnostic output
  if (stderrChunks.length > 0) {
    const stderr = stderrChunks.join("").trim();
    if (stderr) {
      job.output.push(`\n[stderr] ${stderr}`);
    }
  }

  push(job.id, "status", JSON.stringify({ status: job.status, exitCode }));
  close(job.id);

  notify(job);
}

function notify(job: ChainJob) {
  const statusLabel = job.status === "pass" ? "✓" : "✗";
  const skillLabel = job.skill.replace(/^\//, "");
  const elapsed = job.completedAt
    ? Math.round((job.completedAt.getTime() - job.startedAt.getTime()) / 1000)
    : 0;

  const message = job.status === "pass"
    ? `${skillLabel} passed (${elapsed}s)`
    : `${skillLabel} failed — check sideclaw`;

  const priority = job.status === "pass" ? "2" : "4";
  const tag = job.status === "pass" ? "white_check_mark" : "x";

  Bun.spawnSync([
    "ntfy-mac", "notify",
    "-t", `sideclaw ${statusLabel}`,
    "-m", message,
    "-p", priority,
    "--tag", tag,
    "--url", "http://sideclaw.local",
  ], { stderr: "ignore" });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getJob(id: string): ChainJob | undefined {
  return jobs.get(id);
}

/** Returns a ReadableStream<string> that emits SSE-formatted events for a job. */
export function subscribeToJob(id: string): ReadableStream<string> | null {
  const job = jobs.get(id);
  if (!job) return null;

  return new ReadableStream<string>({
    start(ctrl) {
      // Replay buffered output for late subscribers
      for (const line of job.output) {
        ctrl.enqueue(`event: output\ndata: ${JSON.stringify(line)}\n\n`);
      }
      if (job.status !== "running") {
        ctrl.enqueue(
          `event: status\ndata: ${JSON.stringify({ status: job.status, exitCode: job.exitCode })}\n\n`,
        );
        ctrl.close();
        return;
      }
      // Register for live events
      if (!subscribers.has(id)) subscribers.set(id, new Set());
      subscribers.get(id)!.add(ctrl);
    },
    cancel(ctrl) {
      subscribers.get(id)?.delete(ctrl as SseController);
    },
  });
}
