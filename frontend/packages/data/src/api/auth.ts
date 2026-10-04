import { z } from 'zod'

// Wire schemas of the backend auth routes (packages/api/src/platform/core/auth-routes.ts).

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DIGEST = /^0x[0-9a-f]{64}$/

/** GET /api/v1/auth/session and POST /api/v1/auth/siwe/verify. */
export const pineSessionSchema = z.object({
  wallet: z.string().regex(ADDRESS),
  githubUserId: z.number().int().positive().nullable(),
  githubLogin: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/)
    .nullable(),
  isAdmin: z.boolean(),
  termsDigest: z.string().regex(DIGEST),
  termsAccepted: z.boolean(),
  authenticatedAt: z.string(),
  idleExpiresAt: z.string(),
  absoluteExpiresAt: z.string(),
})

/** The signed-in backend session (wallet, linked GitHub identity, terms acceptance). */
export type PineSession = z.infer<typeof pineSessionSchema>

/** POST /api/v1/auth/siwe/challenge. */
export const siweChallengeSchema = z.object({
  message: z.string().min(1).max(4096),
  nonce: z.string().min(1).max(128),
  expiresAt: z.string(),
})

/** POST /api/v1/auth/github/start. */
export const githubStartSchema = z.object({ authorizationUrl: z.string().max(4096) })

/** Any body (204 answers and routes whose body the caller ignores). */
export const anyBodySchema = z.unknown()
