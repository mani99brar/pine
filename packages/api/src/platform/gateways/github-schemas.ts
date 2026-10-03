// zod schemas for every GitHub response the gateways read (SEC-GH-15): numeric ids, 40-hex lowercase SHAs, owner/name
// charsets and bounded string lengths. Unknown fields are ignored; anything that does not match is an UPSTREAM failure.

import { z } from "zod";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const SHA_PATTERN = /^[0-9a-f]{40}$/;
const sha = z.string().regex(SHA_PATTERN);
const login = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const repoName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
const ref = z.string().min(1).max(255);
const url = z.string().max(2048).regex(/^https:\/\//);
const timestamp = z.string().max(40);

export const githubUserSchema = z.object({ id, login });

export const githubRepoSchema = z.object({
  id,
  name: repoName,
  full_name: z.string().max(201),
  owner: z.object({ id, login }),
  private: z.boolean(),
  // Absent visibility is refused like a private repository (fail closed).
  visibility: z.string().max(32).optional(),
  fork: z.boolean(),
  default_branch: ref,
  html_url: url,
  pushed_at: timestamp.nullable().optional(),
  permissions: z
    .object({
      admin: z.boolean().optional(),
      maintain: z.boolean().optional(),
      push: z.boolean().optional(),
      triage: z.boolean().optional(),
      pull: z.boolean().optional(),
    })
    .optional(),
});
export type GitHubRepoPayload = z.infer<typeof githubRepoSchema>;

export const githubPullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(1024),
  state: z.enum(["open", "closed"]),
  merged: z.boolean().optional(),
  merged_at: timestamp.nullable().optional(),
  html_url: url,
  updated_at: timestamp,
  user: z.object({ login }).nullable().optional(),
  head: z.object({ sha, ref, repo: z.object({ id }).nullable().optional() }),
  base: z.object({ sha, ref, repo: githubRepoSchema }),
  commits: z.number().int().nonnegative().optional(),
});
export type GitHubPullPayload = z.infer<typeof githubPullSchema>;

export const githubCommitSchema = z.object({
  sha,
  html_url: url,
  parents: z.array(z.object({ sha })).max(100),
  author: z.object({ login }).nullable().optional(),
  commit: z.object({
    message: z.string().max(65_536),
    committer: z.object({ date: timestamp.nullable().optional() }).nullable().optional(),
  }),
});
export type GitHubCommitPayload = z.infer<typeof githubCommitSchema>;

/** GET /repos/{o}/{r}/branches/{name}: only the resolved name and head commit are read. */
export const githubBranchSchema = z.object({ name: ref, commit: z.object({ sha }) });

export const githubCompareSchema = z.object({
  status: z.enum(["diverged", "ahead", "behind", "identical"]),
  ahead_by: z.number().int().nonnegative(),
  behind_by: z.number().int().nonnegative(),
});
