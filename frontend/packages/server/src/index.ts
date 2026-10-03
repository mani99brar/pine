/**
 * @pine/server — Next.js route handlers for Pine apps. SERVER ONLY: never import from client
 * components ('use client' files). Each handler is a plain Fetch API function (Request → Response).
 */
if (typeof window !== 'undefined') {
  throw new Error('@pine/server must not be imported from client code.')
}

export { createAuth, type CreateAuthOptions, type PineAuth } from './auth'
export type { PineSessionUser, PineAuthExtras, SessionGetter, PineAuthLike } from './session'
export { createGitHubHandler, mapGitHubError, type GitHubHandlerOptions } from './github'
export {
  createAccountHandler,
  verifySiwe,
  preferencesPatchSchema,
  NONCE_COOKIE,
  type AccountHandlerOptions,
  type VerifySiweInput,
  type VerifySiweResult,
} from './siwe'
export {
  createAgentHandler,
  llmsTxtHandler,
  llmsFullTxtHandler,
  wellKnownHandler,
  parseClaimQuery,
  claimIdCandidates,
  type AgentHandlerOptions,
  type RootFileOptions,
} from './agent'
export { createIpfsHandler, rawCidV1, extractCidPath, IPFS_MAX_BYTES, type IpfsHandlerOptions } from './ipfs'
export { readServerEnv, resolveSiteUrl, demoAllowed, DEV_AUTH_SECRET, PineConfigError, type ServerEnv } from './env'
export { ACCOUNT_COOKIE, signValue, unsignValue, mintApiToken, verifyApiToken, API_TOKEN_TTL_SECONDS, type ApiTokenClaims } from './account-store'
export { PUBLIC_CACHE, CORS_HEADERS, type CatchAllContext } from './http'
