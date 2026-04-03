import type { RepoInfo } from "../server/lib/repo-scanner";
import type { QueueTask } from "../server/lib/parse-queue";
import type { GitStatus, GitFile, GitCommit, Worktree } from "../server/lib/git";
import type { CompletedTask } from "../server/lib/db";

export type { RepoInfo, QueueTask, GitStatus, GitFile, GitCommit, Worktree, CompletedTask };

export interface RepoData {
  repo: RepoInfo;
  queue: QueueTask[];
  notes: string;
  notesModifiedAt: number;
}

// GitHub types defined here to avoid Vite bundling server-side @octokit/rest
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checks: { total: number; passing: number; failing: number; pending: number };
}

export interface WorkflowRun {
  id: number;
  name: string;
  status: "completed" | "in_progress" | "queued";
  conclusion: "success" | "failure" | "cancelled" | "skipped" | null;
  createdAt: string;
  url: string;
}

export interface GithubData {
  currentPR: PullRequest | null;
  openPRs: { number: number; title: string; url: string }[];
  workflowRuns: WorkflowRun[];
  latestRelease: { tagName: string; publishedAt: string; url: string } | null;
  hasReleaseWorkflow: boolean;
}
