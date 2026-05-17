import { Elysia } from "elysia";
import { getGithubData, triggerRelease } from "../lib/github";
import { gitDisabled } from "../lib/feature-flags";

export const githubRoutes = new Elysia({ prefix: "/api" })
  .get("/github", async ({ query, set }) => {
    if (gitDisabled) return { ok: true as const, data: null };

    const { githubRepo, branch } = query;
    if (!githubRepo || !branch) {
      set.status = 400;
      return { ok: false as const, error: "Missing githubRepo or branch" };
    }
    const parts = githubRepo.split("/");
    const owner = parts[0];
    const repo = parts[1];
    if (!owner || !repo) {
      set.status = 400;
      return { ok: false as const, error: "Invalid githubRepo format (expected owner/repo)" };
    }
    const data = await getGithubData(owner, repo, branch);
    return { ok: true as const, data };
  })
  .post("/github/trigger-release", async ({ query, set }) => {
    if (gitDisabled) {
      set.status = 503;
      return { ok: false as const, error: "Git integration disabled" };
    }

    const { githubRepo, ref } = query;
    if (!githubRepo) {
      set.status = 400;
      return { ok: false as const, error: "Missing githubRepo" };
    }
    const parts = githubRepo.split("/");
    const owner = parts[0];
    const repo = parts[1];
    if (!owner || !repo) {
      set.status = 400;
      return { ok: false as const, error: "Invalid githubRepo format" };
    }
    try {
      await triggerRelease(owner, repo, ref ?? "main");
      return { ok: true as const };
    } catch (err) {
      set.status = 500;
      return { ok: false as const, error: String(err) };
    }
  });
