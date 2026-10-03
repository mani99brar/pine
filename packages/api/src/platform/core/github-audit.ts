// Auditing decorator around gateways.github, exposed to modules as ctx.github (PRD-02 2.4). The gateway reports a
// revoked link (GitHub 401, token decrypt failure, rejected refresh) only through GitHubGatewayError("GITHUB_NOT_LINKED")
// after deleting the token. Before forwarding, the decorator reads the user's identity; when it was non-null and the call
// rejects with GITHUB_NOT_LINKED it records github.link.revoked, then rethrows, so a module that catches the error
// cannot hide the revocation. Users who never linked GitHub get the same error and no audit row.

import type { AuditLog, GitHubGateway } from "../../contracts/app.js";
import { GitHubGatewayError } from "../../contracts/app.js";
import type { GitHubAuthFlow } from "../../contracts/platform.js";

type GitHubMethod = keyof GitHubGateway;

export function createAuditingGitHub(inner: GitHubGateway, auth: Pick<GitHubAuthFlow, "identityOf">, audit: AuditLog, onAuditError: (error: unknown) => void = () => undefined): GitHubGateway {
  async function call<T>(method: GitHubMethod, userId: string, invoke: () => Promise<T>): Promise<T> {
    const identity = await auth.identityOf(userId);
    try {
      return await invoke();
    } catch (error) {
      if (identity !== null && error instanceof GitHubGatewayError && error.code === "GITHUB_NOT_LINKED") {
        try {
          await audit.record({
            actorUserId: userId,
            action: "github.link.revoked",
            subjectType: "user",
            subjectId: userId,
            details: { method, githubUserId: identity.githubUserId },
            ip: null,
          });
        } catch (auditError) {
          onAuditError(auditError);
        }
      }
      throw error;
    }
  }

  return {
    listPublicRepos: (userId, page) => call("listPublicRepos", userId, () => inner.listPublicRepos(userId, page)),
    getRepo: (userId, owner, name) => call("getRepo", userId, () => inner.getRepo(userId, owner, name)),
    getRepoById: (userId, repoId) => call("getRepoById", userId, () => inner.getRepoById(userId, repoId)),
    listPulls: (userId, owner, name, state, page) => call("listPulls", userId, () => inner.listPulls(userId, owner, name, state, page)),
    getPull: (userId, owner, name, number) => call("getPull", userId, () => inner.getPull(userId, owner, name, number)),
    listPullCommits: (userId, owner, name, number) => call("listPullCommits", userId, () => inner.listPullCommits(userId, owner, name, number)),
    getCommit: (userId, owner, name, sha) => call("getCommit", userId, () => inner.getCommit(userId, owner, name, sha)),
    verifyCommitMembership: (userId, owner, name, sha, ref) => call("verifyCommitMembership", userId, () => inner.verifyCommitMembership(userId, owner, name, sha, ref)),
  };
}
