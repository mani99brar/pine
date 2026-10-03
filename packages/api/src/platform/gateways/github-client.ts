// Low-level GitHub HTTP: the OAuth token endpoint (code exchange, refresh), token and grant revocation with client
// credentials and REST calls to https://api.github.com. Only these two origins are ever contacted. Callers map failures
// to their own error types; nothing here logs, and no message built here contains a token or response body.

import { z } from "zod";
import type { PlatformSecrets } from "../../contracts/platform.js";
import { HttpError, parseJsonBody, type HttpClient } from "./http.js";

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_WEB_ORIGIN = "https://github.com";
export const GITHUB_TOKEN_URL = `${GITHUB_WEB_ORIGIN}/login/oauth/access_token`;
export const GITHUB_AUTHORIZE_URL = `${GITHUB_WEB_ORIGIN}/login/oauth/authorize`;
export const GITHUB_API_VERSION = "2022-11-28";
/** SEC-GH-15: bounded response size for every GitHub call. */
export const GITHUB_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TOKEN_ENDPOINT_MAX_BYTES = 64 * 1024;

/** A token endpoint call that GitHub answered with an OAuth error (e.g. bad_verification_code, bad_refresh_token). */
export class OAuthRejectedError extends Error {
  readonly oauthError: string;
  constructor(oauthError: string) {
    super(`GitHub rejected the OAuth request (${oauthError})`);
    this.name = "OAuthRejectedError";
    this.oauthError = oauthError;
  }
}

/** Transport failure, unexpected status or malformed response from GitHub. The message never contains secrets. */
export class GitHubUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubUpstreamError";
  }
}

const tokenString = z.string().min(1).max(1024).regex(/^[\x21-\x7e]+$/);
const lifetime = z.number().int().positive().max(10 * 365 * 86_400);

const tokenSuccess = z.object({
  access_token: tokenString,
  token_type: z.string().max(32).refine((value) => value.toLowerCase() === "bearer"),
  scope: z.string().max(1024).optional(),
  expires_in: lifetime.optional(),
  refresh_token: tokenString.optional(),
  refresh_token_expires_in: lifetime.optional(),
});
const tokenFailure = z.object({ error: z.string().min(1).max(100).regex(/^[a-z_]+$/) });

export interface TokenGrant {
  accessToken: string;
  accessExpiresAt: Date | null;
  refreshToken: string | null;
  refreshExpiresAt: Date | null;
  /** Granted scopes as reported by the token endpoint ("" for none). */
  scope: string;
}

export interface GitHubApiResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON body (null for empty bodies). Throws GitHubUpstreamError for non-JSON 2xx bodies. */
  json: unknown;
}

export interface GitHubClient {
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }, now: Date): Promise<TokenGrant>;
  refresh(refreshToken: string, now: Date): Promise<TokenGrant>;
  /** DELETE /applications/{client_id}/token. Resolves when GitHub revoked it or already considers it invalid. */
  revokeToken(accessToken: string): Promise<void>;
  /** DELETE /applications/{client_id}/grant: revokes the whole authorization (every token of the user for this app). */
  revokeGrant(accessToken: string): Promise<void>;
  /** Authenticated REST GET (path starting with "/"), size-capped. Redirects are refused (thrown) unless `redirect` is
   *  "manual", in which case the 3xx status is returned and never followed. */
  get(token: string, path: string, options?: { redirect?: "error" | "manual" }): Promise<GitHubApiResponse>;
}

export function createGitHubClient(http: HttpClient, github: PlatformSecrets["github"]): GitHubClient {
  const apiHeaders = (token: string): Record<string, string> => ({
    accept: "application/vnd.github+json",
    "x-github-api-version": GITHUB_API_VERSION,
    authorization: `Bearer ${token}`,
    "user-agent": "pine-api",
  });

  async function send(url: string, init: Parameters<HttpClient["request"]>[1]) {
    try {
      return await http.request(url, init);
    } catch (error) {
      if (error instanceof HttpError) throw new GitHubUpstreamError(`GitHub request failed (${error.kind})`);
      throw error;
    }
  }

  async function tokenRequest(params: Record<string, string>, now: Date): Promise<TokenGrant> {
    const response = await send(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "pine-api" },
      body: new URLSearchParams({ client_id: github.clientId, client_secret: github.clientSecret, ...params }).toString(),
      maxBytes: TOKEN_ENDPOINT_MAX_BYTES,
    });
    let body: unknown;
    try {
      body = parseJsonBody(response.body);
    } catch {
      throw new GitHubUpstreamError(`GitHub token endpoint returned a non-JSON body (status ${response.status})`);
    }
    // GitHub reports OAuth errors with status 200 and an `error` field; 4xx bodies carry the same shape.
    const failure = tokenFailure.safeParse(body);
    if (failure.success && (response.status === 200 || (response.status >= 400 && response.status < 500))) {
      throw new OAuthRejectedError(failure.data.error);
    }
    if (response.status !== 200) throw new GitHubUpstreamError(`GitHub token endpoint returned status ${response.status}`);
    const parsed = tokenSuccess.safeParse(body);
    if (!parsed.success) throw new GitHubUpstreamError("GitHub token endpoint returned an unexpected response");
    const at = (seconds: number | undefined) => (seconds === undefined ? null : new Date(now.getTime() + seconds * 1000));
    return {
      accessToken: parsed.data.access_token,
      accessExpiresAt: at(parsed.data.expires_in),
      refreshToken: parsed.data.refresh_token ?? null,
      refreshExpiresAt: parsed.data.refresh_token === undefined ? null : at(parsed.data.refresh_token_expires_in),
      scope: (parsed.data.scope ?? "").trim(),
    };
  }

  async function deleteWithClientCredentials(what: "token" | "grant", accessToken: string): Promise<void> {
    const basic = Buffer.from(`${github.clientId}:${github.clientSecret}`, "utf8").toString("base64");
    const response = await send(`${GITHUB_API_ORIGIN}/applications/${encodeURIComponent(github.clientId)}/${what}`, {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": GITHUB_API_VERSION,
        authorization: `Basic ${basic}`,
        "content-type": "application/json",
        "user-agent": "pine-api",
      },
      body: JSON.stringify({ access_token: accessToken }),
      maxBytes: TOKEN_ENDPOINT_MAX_BYTES,
    });
    // 204: revoked. 404/422: GitHub no longer knows the token (already revoked or expired).
    if (response.status === 204 || response.status === 404 || response.status === 422) return;
    throw new GitHubUpstreamError(`GitHub ${what} revocation returned status ${response.status}`);
  }

  return {
    exchangeCode(input, now) {
      return tokenRequest({ code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier }, now);
    },
    refresh(refreshToken, now) {
      return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, now);
    },
    revokeToken(accessToken) {
      return deleteWithClientCredentials("token", accessToken);
    },
    revokeGrant(accessToken) {
      return deleteWithClientCredentials("grant", accessToken);
    },
    async get(token, path, options = {}) {
      if (!path.startsWith("/")) throw new GitHubUpstreamError("Invalid GitHub API path");
      const response = await send(`${GITHUB_API_ORIGIN}${path}`, {
        method: "GET",
        headers: apiHeaders(token),
        maxBytes: GITHUB_MAX_RESPONSE_BYTES,
        redirect: options.redirect ?? "error",
      });
      let json: unknown = null;
      if (response.body.byteLength > 0) {
        try {
          json = parseJsonBody(response.body);
        } catch {
          if (response.status >= 200 && response.status < 300) throw new GitHubUpstreamError("GitHub returned a non-JSON body");
          json = null;
        }
      }
      return { status: response.status, headers: response.headers, json };
    },
  };
}
