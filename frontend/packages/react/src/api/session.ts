'use client'

import { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSignMessage } from 'wagmi'
import { parseSiweMessage } from 'viem/siwe'
import type { Address } from '@pine/core'
import {
  anyBodySchema,
  githubStartSchema,
  PineBackendError,
  pineSessionSchema,
  siweChallengeSchema,
  type PineApiClient,
  type PineSession,
} from '@pine/data'
import { usePine } from '../providers/context'
import { pineKeys } from '../queries/keys'
import { useWallet } from '../wallet'

// Backend identity (`api` mode, packages/api/src/platform/core/auth-routes.ts): a wallet signs in with SIWE (EOA only);
// GitHub is linked to that wallet's account afterwards. The session is an HttpOnly `__Host-pine_session` cookie, so
// the browser only ever sees the session view below.

export { pineSessionSchema, type PineSession }

const challengeSchema = siweChallengeSchema
const startSchema = githubStartSchema
const emptySchema = anyBodySchema

/** The statement the backend puts in every SIWE message (siwe.ts `termsStatement`). */
export const SIWE_TERMS_STATEMENT = /^Sign in to Pine\. I accept the terms with sha256 (0x[0-9a-f]{64})\.$/

export class SiweChallengeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SiweChallengeError'
  }
}

/**
 * Checks the server-issued EIP-4361 message before the wallet signs it: it must sign this site in (domain and URI are
 * the page's own origin), for the connected address, on the expected chain, with Pine's terms statement, and expire
 * soon. A compromised or misrouted API therefore cannot obtain a signature usable on another site.
 * Returns the terms digest the user accepts by signing.
 */
export function checkSiweChallenge(
  message: string,
  expected: { address: Address; origin: string; chainId: number; now?: Date },
): { termsDigest: string } {
  let parsed: ReturnType<typeof parseSiweMessage>
  try {
    parsed = parseSiweMessage(message)
  } catch {
    throw new SiweChallengeError('The sign-in message is malformed.')
  }
  const origin = new URL(expected.origin)
  const now = expected.now ?? new Date()
  if (parsed.domain !== origin.host) throw new SiweChallengeError('The sign-in message is for another site.')
  if (!parsed.uri || new URL(parsed.uri).origin !== origin.origin) throw new SiweChallengeError('The sign-in message names another site.')
  if (!parsed.address || parsed.address.toLowerCase() !== expected.address.toLowerCase()) {
    throw new SiweChallengeError('The sign-in message is for another wallet.')
  }
  if (parsed.chainId !== expected.chainId) throw new SiweChallengeError('The sign-in message is for another chain.')
  if (parsed.version !== '1') throw new SiweChallengeError('The sign-in message has an unsupported version.')
  const statement = parsed.statement ? SIWE_TERMS_STATEMENT.exec(parsed.statement) : null
  if (!statement?.[1]) throw new SiweChallengeError('The sign-in message does not carry Pine’s terms statement.')
  if (!parsed.nonce || !/^[0-9a-f]{32}$/.test(parsed.nonce)) throw new SiweChallengeError('The sign-in message has an invalid nonce.')
  if (!parsed.expirationTime || parsed.expirationTime.getTime() <= now.getTime() || parsed.expirationTime.getTime() - now.getTime() > 15 * 60_000) {
    throw new SiweChallengeError('The sign-in message has an invalid expiry.')
  }
  if (parsed.resources && parsed.resources.length > 0) throw new SiweChallengeError('The sign-in message requests extra resources.')
  return { termsDigest: statement[1] }
}

/** Only GitHub's own authorization endpoint is followed (the backend's start route returns it). */
export function checkGitHubAuthorizationUrl(raw: string): string {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.host !== 'github.com' || url.pathname !== '/login/oauth/authorize') {
    throw new Error('The GitHub authorization link is not a github.com authorization URL.')
  }
  return url.toString()
}

function requireApi(api: PineApiClient | null): PineApiClient {
  if (!api) throw new Error('The Pine API is not configured (set NEXT_PUBLIC_PINE_DATA_SOURCE=api).')
  return api
}

/** Query keys that hold per-user data; cleared whenever the signed-in identity changes. */
const USER_KEYS = new Set(['session', 'account', 'drafts', 'draft', 'github', 'notifications', 'portfolio', 'plans'])

export interface PineSessionState {
  /** `disabled` outside `api` mode. */
  status: 'disabled' | 'loading' | 'signed_out' | 'signed_in'
  session: PineSession | null
  error: Error | null
  refresh(): Promise<void>
}

/** The backend session: GET /api/v1/auth/session (401 → signed out). */
export function usePineSession(): PineSessionState {
  const { api } = usePine()
  const qc = useQueryClient()
  const q = useQuery<PineSession | null, Error>({
    queryKey: pineKeys.session(),
    enabled: api !== null,
    staleTime: 60_000,
    retry: (count, error) => !(error instanceof PineBackendError && error.status > 0 && error.status < 500) && count < 2,
    queryFn: async () => {
      try {
        return await requireApi(api).get('/api/v1/auth/session', pineSessionSchema)
      } catch (e) {
        if (e instanceof PineBackendError && e.status === 401) return null
        throw e
      }
    },
  })
  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: pineKeys.session() })
  }, [qc])
  let status: PineSessionState['status']
  if (api === null) status = 'disabled'
  else if (q.isPending) status = 'loading'
  else status = q.data ? 'signed_in' : 'signed_out'
  return { status, session: q.data ?? null, error: q.error, refresh }
}

export type SiweStep = 'idle' | 'connecting' | 'challenge' | 'signing' | 'verifying' | 'done' | 'error'

/**
 * Sign-In with Ethereum against the backend: challenge (server-built message) → local checks → wallet signature →
 * verify (sets the session cookie). Signing also records acceptance of the terms digest in the message.
 */
export function useSiweSignIn(): { signIn(): Promise<PineSession>; step: SiweStep; error: string | null; reset(): void } {
  const { api, env } = usePine()
  const qc = useQueryClient()
  const wallet = useWallet()
  const { signMessageAsync } = useSignMessage()
  const [step, setStep] = useState<SiweStep>('idle')
  const [error, setError] = useState<string | null>(null)

  const signIn = useCallback(async (): Promise<PineSession> => {
    setError(null)
    try {
      const client = requireApi(api)
      if (!wallet.isConnected || !wallet.address) {
        setStep('connecting')
        wallet.connect()
        throw new Error('Connect a wallet, then sign in.')
      }
      const address = wallet.address
      setStep('challenge')
      const challenge = await client.post('/api/v1/auth/siwe/challenge', challengeSchema, { address: address.toLowerCase() })
      checkSiweChallenge(challenge.message, { address, origin: window.location.origin, chainId: env.defaultChainId })
      setStep('signing')
      const signature = await signMessageAsync({ message: challenge.message, account: address })
      setStep('verifying')
      const session = await client.post('/api/v1/auth/siwe/verify', pineSessionSchema, { message: challenge.message, signature })
      qc.removeQueries({ predicate: (query) => query.queryKey[0] === 'pine' && USER_KEYS.has(String(query.queryKey[1])) })
      qc.setQueryData(pineKeys.session(), session)
      setStep('done')
      return session
    } catch (e) {
      const msg = (e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : String(e))
      setError(msg)
      setStep('error')
      throw e instanceof Error ? e : new Error(msg)
    }
  }, [api, env.defaultChainId, wallet, signMessageAsync, qc])

  const reset = useCallback(() => {
    setStep('idle')
    setError(null)
  }, [])

  return { signIn, step, error, reset }
}

/** POST /api/v1/auth/logout (`everywhere` ends every session of the account). */
export function useSignOut(): (opts?: { everywhere?: boolean }) => Promise<void> {
  const { api } = usePine()
  const qc = useQueryClient()
  return useCallback(
    async (opts?: { everywhere?: boolean }) => {
      try {
        await requireApi(api).request('POST', '/api/v1/auth/logout', emptySchema, { body: opts?.everywhere ? { everywhere: true } : {} })
      } finally {
        qc.removeQueries({ predicate: (query) => query.queryKey[0] === 'pine' && USER_KEYS.has(String(query.queryKey[1])) })
        qc.setQueryData(pineKeys.session(), null)
      }
    },
    [api, qc],
  )
}

/**
 * GitHub linking for the signed-in wallet. `link()` asks the backend for a single-use authorization URL (PKCE, state
 * bound to the session) and navigates to github.com; GitHub returns to the backend callback, which redirects to
 * `/settings?github=linked|error`. `unlink()` revokes the grant and ends the session (sign in again afterwards).
 */
export function useGitHubLink(): { link(): Promise<void>; unlink(): Promise<void>; busy: boolean; error: string | null } {
  const { api } = usePine()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const link = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const { authorizationUrl } = await requireApi(api).post('/api/v1/auth/github/start', startSchema)
      window.location.assign(checkGitHubAuthorizationUrl(authorizationUrl))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
      throw e
    }
  }, [api])

  const unlink = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      await requireApi(api).request('DELETE', '/api/v1/auth/github', emptySchema)
      qc.removeQueries({ predicate: (query) => query.queryKey[0] === 'pine' && USER_KEYS.has(String(query.queryKey[1])) })
      qc.setQueryData(pineKeys.session(), null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      setBusy(false)
    }
  }, [api, qc])

  return { link, unlink, busy, error }
}
