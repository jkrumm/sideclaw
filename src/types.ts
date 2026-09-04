import type { RepoInfo } from "../server/lib/repo-scanner";
import type { GitStatus, GitFile, GitCommit, Worktree } from "../server/lib/git";

export type { RepoInfo, GitStatus, GitFile, GitCommit, Worktree };

export interface RepoData {
  repo: RepoInfo;
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
