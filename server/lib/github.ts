import { Octokit } from "@octokit/rest";

// Silence the built-in request-log plugin — 404s for repos without releases
// are expected and handled via allSettled; real errors bubble to our catch.
const octokit = process.env.GITHUB_TOKEN
  ? new Octokit({
      auth: process.env.GITHUB_TOKEN,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    })
  : null;

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

export async function getGithubData(
  owner: string,
  repo: string,
  branch: string,
): Promise<GithubData | null> {
  if (!octokit) return null;

  try {
    const [prsResult, allPrsResult, runsResult, releaseResult, workflowResult] =
      await Promise.allSettled([
        octokit.pulls.list({ owner, repo, state: "open", head: `${owner}:${branch}` }),
        octokit.pulls.list({ owner, repo, state: "open", per_page: 10 }),
        octokit.actions.listWorkflowRunsForRepo({ owner, repo, per_page: 5 }),
        octokit.repos.getLatestRelease({ owner, repo }),
        octokit.repos.getContent({
          owner,
          repo,
          path: ".github/workflows/release.yml",
        }),
      ]);

    // Resolve PR with checks + reviews
    let currentPR: PullRequest | null = null;
    if (
      prsResult.status === "fulfilled" &&
      prsResult.value.data.length > 0
    ) {
      const pr = prsResult.value.data[0]!;

      const [checksResult, reviewsResult] = await Promise.allSettled([
        octokit.checks.listForRef({ owner, repo, ref: branch }),
        octokit.pulls.listReviews({ owner, repo, pull_number: pr.number }),
      ]);

      let checks = { total: 0, passing: 0, failing: 0, pending: 0 };
      if (checksResult.status === "fulfilled") {
        const checkRuns = checksResult.value.data.check_runs;
        checks.total = checkRuns.length;
        for (const run of checkRuns) {
          if (run.conclusion === "success") checks.passing++;
          else if (
            run.conclusion === "failure" ||
            run.conclusion === "action_required"
          )
            checks.failing++;
          else checks.pending++;
        }
      }

      let reviewDecision: PullRequest["reviewDecision"] = null;
      if (reviewsResult.status === "fulfilled") {
        const reviews = reviewsResult.value.data;
        const latestByReviewer = new Map<number, string>();
        for (const review of reviews) {
          if (review.state !== "COMMENTED" && review.user?.id) {
            latestByReviewer.set(review.user.id, review.state);
          }
        }
        const states = [...latestByReviewer.values()];
        if (states.some((s) => s === "CHANGES_REQUESTED"))
          reviewDecision = "CHANGES_REQUESTED";
        else if (states.some((s) => s === "APPROVED"))
          reviewDecision = "APPROVED";
        else reviewDecision = "REVIEW_REQUIRED";
      }

      currentPR = {
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        reviewDecision,
        checks,
      };
    }

    // Workflow runs
    const workflowRuns: WorkflowRun[] = [];
    if (runsResult.status === "fulfilled") {
      for (const run of runsResult.value.data.workflow_runs) {
        workflowRuns.push({
          id: run.id,
          name: run.name ?? "Unknown",
          status: run.status as WorkflowRun["status"],
          conclusion: run.conclusion as WorkflowRun["conclusion"],
          createdAt: run.created_at,
          url: run.html_url,
        });
      }
    }

    // Latest release
    let latestRelease: GithubData["latestRelease"] = null;
    if (releaseResult.status === "fulfilled") {
      const rel = releaseResult.value.data;
      latestRelease = {
        tagName: rel.tag_name,
        publishedAt: rel.published_at ?? rel.created_at,
        url: rel.html_url,
      };
    }

    const hasReleaseWorkflow = workflowResult.status === "fulfilled";

    const openPRs =
      allPrsResult.status === "fulfilled"
        ? allPrsResult.value.data.map((pr) => ({
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
          }))
        : [];

    return { currentPR, openPRs, workflowRuns, latestRelease, hasReleaseWorkflow };
  } catch (err) {
    console.error("GitHub API error:", err);
    return null;
  }
}

export async function triggerRelease(
  owner: string,
  repo: string,
  ref: string,
): Promise<void> {
  if (!octokit) throw new Error("No GitHub token configured");
  await octokit.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: "release.yml",
    ref,
  });
}
