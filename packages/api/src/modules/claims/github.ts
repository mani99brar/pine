// GitHub browsing (PRD-03 §3): session + linked GitHub, one github_calls_per_hour unit per upstream call. Responses are
// GitHub data returned as untrusted data. getCommit() proves only that an object exists, never membership (SEC-GH-11).

import { z } from "zod";
import { GitHubGatewayError, type AppContext } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { sessionOf } from "./common.js";
import type { ClaimsRouteDeps } from "./state.js";

export const githubOwnerSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "invalid GitHub owner");
export const githubRepoNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, "invalid repository name")
  .refine((value) => value !== "." && value !== "..", "invalid repository name");
export const commitShaSchema = z.string().regex(/^[0-9a-fA-F]{40}$/, "must be a full 40-hex commit id").transform((value) => value.toLowerCase());
export const branchNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._/-]{1,200}$/, "invalid branch name")
  .refine((value) => !value.split("/").some((part) => part === "" || part === "." || part === ".."), "invalid branch name");
const positiveInt = z.coerce.number().int().positive().max(2 ** 31 - 1);
const pageSchema = z.coerce.number().int().min(1).max(100).default(1);

const repoParams = z.object({ owner: githubOwnerSchema, name: githubRepoNameSchema }).strict();
const pullParams = repoParams.extend({ number: positiveInt }).strict();
const commitParams = repoParams.extend({ sha: commitShaSchema }).strict();

/** Maps gateway failures to client errors (PRD-03 §3). Anything else propagates (INTERNAL). */
export function mapGitHubError(error: unknown): unknown {
  if (!(error instanceof GitHubGatewayError)) return error;
  switch (error.code) {
    case "GITHUB_NOT_LINKED":
      return new ApiError("FORBIDDEN", "Connect your GitHub account first");
    case "REPO_NOT_PUBLIC":
      return new ApiError("UNPROCESSABLE", "Only public repositories are supported");
    case "NOT_FOUND":
      return new ApiError("NOT_FOUND", "Not found on GitHub");
    case "NOT_A_MEMBER":
      return new ApiError("UNPROCESSABLE", "The commit is not part of the selected pull request or branch");
    case "RATE_LIMITED":
      return new ApiError("RATE_LIMITED", "GitHub rate limit reached; try again later", { retryAfterSeconds: 60 });
    case "UPSTREAM":
      return new ApiError("UPSTREAM_UNAVAILABLE", "GitHub is unavailable; try again later");
  }
}

/** One quota unit, then the upstream call; gateway errors are mapped. */
export async function githubCall<T>(ctx: AppContext, userId: string, call: () => Promise<T>): Promise<T> {
  await ctx.quotas.consume(userId, "github_calls_per_hour");
  try {
    return await call();
  } catch (error) {
    throw mapGitHubError(error);
  }
}

export function registerGitHubRoutes({ app, ctx }: ClaimsRouteDeps): void {
  const guard = { preHandler: app.requireSession };

  app.get("/api/v1/github/repos", { ...guard, schema: { querystring: z.object({ page: pageSchema }).strict() } }, async (request) => {
    const session = sessionOf(request);
    return githubCall(ctx, session.userId, () => ctx.github.listPublicRepos(session.userId, request.query.page));
  });

  app.get("/api/v1/github/repos/:owner/:name", { ...guard, schema: { params: repoParams } }, async (request) => {
    const session = sessionOf(request);
    const { owner, name } = request.params;
    return githubCall(ctx, session.userId, () => ctx.github.getRepo(session.userId, owner, name));
  });

  app.get(
    "/api/v1/github/repos/:owner/:name/pulls",
    { ...guard, schema: { params: repoParams, querystring: z.object({ state: z.enum(["open", "closed", "all"]).default("open"), page: pageSchema }).strict() } },
    async (request) => {
      const session = sessionOf(request);
      const { owner, name } = request.params;
      return githubCall(ctx, session.userId, () => ctx.github.listPulls(session.userId, owner, name, request.query.state, request.query.page));
    },
  );

  app.get("/api/v1/github/repos/:owner/:name/pulls/:number", { ...guard, schema: { params: pullParams } }, async (request) => {
    const session = sessionOf(request);
    const { owner, name, number } = request.params;
    return githubCall(ctx, session.userId, () => ctx.github.getPull(session.userId, owner, name, number));
  });

  app.get("/api/v1/github/repos/:owner/:name/pulls/:number/commits", { ...guard, schema: { params: pullParams } }, async (request) => {
    const session = sessionOf(request);
    const { owner, name, number } = request.params;
    const items = await githubCall(ctx, session.userId, () => ctx.github.listPullCommits(session.userId, owner, name, number));
    return { items };
  });

  app.get("/api/v1/github/repos/:owner/:name/commits/:sha", { ...guard, schema: { params: commitParams } }, async (request) => {
    const session = sessionOf(request);
    const { owner, name, sha } = request.params;
    const commit = await githubCall(ctx, session.userId, () => ctx.github.getCommit(session.userId, owner, name, sha));
    if (!commit) throw new ApiError("NOT_FOUND", "Commit not found");
    // Existence is not membership: drafts prove membership through a pull request or branch at preview time.
    return { commit, membershipVerified: false };
  });
}
