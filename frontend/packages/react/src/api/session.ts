'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useSignMessage } from 'wagmi'
import { createSiweMessage, parseSiweMessage } from 'viem/siwe'
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

/** A parsed date-time that is a real instant (viem parses a malformed one to an Invalid Date, which fails no comparison). */
const validTime = (value: Date | undefined): value is Date => value instanceof Date && Number.isFinite(value.getTime())

/** Longest sign-in message validity accepted, from its issue time to its expiry (the backend issues 10 minutes). */
const SIWE_MAX_VALIDITY_MS = 15 * 60_000
/** Device clock error tolerated before a message counts as stale or from the future. */
const SIWE_CLOCK_SKEW_MS = 60 * 60_000

/**
 * Checks the server-issued EIP-4361 message before the wallet signs it: it must sign this site in (domain and URI are
 * the page's own origin), for the connected address, on the expected chain, with Pine's terms statement, and expire at
 * most 15 minutes after its own issue time (and be neither stale nor from the future by more than an hour on this
 * device's clock, which may be off by minutes). It must also be exactly the canonical message of those fields
 * (SEC-AUTH-01): viem's parser ignores text it does not expect (extra lines before `URI:` or after the last field), so
 * the text is rebuilt from the parsed fields and compared byte for byte. A compromised or misrouted API therefore
 * cannot obtain a signature usable on another site, nor over text the user was not shown as Pine's sign-in. Returns
 * the terms digest the user accepts by signing.
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
  const issuedAt = parsed.issuedAt
  const expiry = parsed.expirationTime
  if (!validTime(issuedAt)) throw new SiweChallengeError('The sign-in message has an invalid issue time.')
  // The validity window comes from the message itself: devices whose clock is minutes off must still sign in (the
  // backend checks freshness against its own clock). The local clock only refuses what no plausible skew explains.
  const validity = validTime(expiry) ? expiry.getTime() - issuedAt.getTime() : Number.NaN
  if (!validTime(expiry) || !(validity > 0) || validity > SIWE_MAX_VALIDITY_MS) {
    throw new SiweChallengeError('The sign-in message has an invalid expiry.')
  }
  if (expiry.getTime() < now.getTime() - SIWE_CLOCK_SKEW_MS) {
    throw new SiweChallengeError('The sign-in message expired more than an hour ago by this device’s clock. Check the clock, then sign in again.')
  }
  if (issuedAt.getTime() > now.getTime() + SIWE_CLOCK_SKEW_MS) {
    throw new SiweChallengeError('The sign-in message is dated more than an hour ahead of this device’s clock. Check the clock, then sign in again.')
  }
  if (parsed.resources && parsed.resources.length > 0) throw new SiweChallengeError('The sign-in message requests extra resources.')
  let canonical: string
  try {
    canonical = createSiweMessage({
      domain: parsed.domain,
      address: parsed.address,
      statement: parsed.statement,
      uri: parsed.uri,
      version: parsed.version,
      chainId: parsed.chainId,
      nonce: parsed.nonce,
      issuedAt,
      expirationTime: expiry,
      notBefore: parsed.notBefore,
      requestId: parsed.requestId,
      scheme: parsed.scheme,
    })
  } catch {
    throw new SiweChallengeError('The sign-in message is malformed.')
  }
  if (canonical !== message) throw new SiweChallengeError('The sign-in message is not exactly Pine’s sign-in message (it carries extra or altered text).')
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

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Local development only: the dev stack simulates GitHub, so a checked github.com authorization URL is opened on its
 * consent page instead (same path and query; `NEXT_PUBLIC_PINE_DEV_GITHUB_ORIGIN`, honoured only for a loopback
 * http(s) origin). Production builds never set it and always go to github.com.
 */
export function githubConsentUrl(checkedUrl: string, devOrigin: string | undefined): string {
  if (!devOrigin) return checkedUrl
  let dev: URL
  try {
    dev = new URL(devOrigin)
  } catch {
    return checkedUrl
  }
  if ((dev.protocol !== 'http:' && dev.protocol !== 'https:') || !LOOPBACK.has(dev.hostname) || dev.pathname !== '/' || dev.search || dev.hash) return checkedUrl
  const github = new URL(checkedUrl)
  return `${dev.origin}${github.pathname}${github.search}`
}

function devGitHubOrigin(): string | undefined {
  try {
    const value = process.env.NEXT_PUBLIC_PINE_DEV_GITHUB_ORIGIN
    return value && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

function requireApi(api: PineApiClient | null): PineApiClient {
  if (!api) throw new Error('The Pine API is not configured (set NEXT_PUBLIC_PINE_DATA_SOURCE=api).')
  return api
}

/**
 * Query keys that hold per-user data; removed whenever the signed-in identity changes. The session query itself is
 * overwritten with setQueryData instead: removing it would leave mounted observers on the old value.
 */
const USER_KEYS = new Set(['account', 'drafts', 'draft', 'github', 'notifications', 'portfolio', 'plans'])

const isUserQuery = (key: readonly unknown[]) => key[0] === 'pine' && USER_KEYS.has(String(key[1]))

/** Drops the per-user queries and records "signed out" for the session in this tab. */
function dropSession(qc: QueryClient): void {
  qc.removeQueries({ predicate: (query) => isUserQuery(query.queryKey) })
  qc.setQueryData(pineKeys.session(), null)
}

/** A 401 from Pine other than a step-up request: the session cookie is missing, expired or was ended elsewhere. */
export function isSessionGone(error: unknown): boolean {
  return error instanceof PineBackendError && error.status === 401 && error.apiCode !== 'STEP_UP_REQUIRED'
}

/**
 * Any backend 401 means this browser has no valid session: the cached session and the per-user data are dropped, as a
 * confirmed sign-out drops them, so the page says signed out instead of "Sign in required" next to "Signed in as".
 * Called for every failed query and mutation (createPineQueryClient) and by direct calls. Returns whether it was one.
 */
export function handleSessionGone(qc: QueryClient, error: unknown): boolean {
  if (!isSessionGone(error)) return false
  if (qc.getQueryData(pineKeys.session()) === null) return true
  dropSession(qc)
  announceSessionChange()
  return true
}

// Cross-tab sync: every tab of this browser shares the session cookie, so a tab that signs in, signs out or changes the
// GitHub link says so on a BroadcastChannel and the other tabs refetch. The message carries no data.
const SESSION_CHANNEL = 'pine:session'
const SESSION_CHANGED = 'session-changed'
const syncedClients = new Map<QueryClient, number>()
let channel: BroadcastChannel | null = null

function onSessionMessage(event: MessageEvent<unknown>): void {
  if (event.data !== SESSION_CHANGED) return
  for (const qc of syncedClients.keys()) {
    void qc.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'pine' && (query.queryKey[1] === 'session' || isUserQuery(query.queryKey)) })
  }
}

function openChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  try {
    return new BroadcastChannel(SESSION_CHANNEL)
  } catch {
    return null
  }
}

/** Tells this browser's other tabs that the Pine session changed (sign-in, sign-out, GitHub link or unlink). */
export function announceSessionChange(): void {
  // A channel never receives its own messages, so the tab's listening channel sends (else a short-lived one).
  const sender = channel ?? openChannel()
  try {
    sender?.postMessage(SESSION_CHANGED)
  } catch {
    // Nothing to tell.
  } finally {
    if (sender && sender !== channel) sender.close()
  }
}

/** Keeps `qc`'s session and per-user queries in step with this browser's other tabs while subscribed. */
function subscribeSessionSync(qc: QueryClient): () => void {
  syncedClients.set(qc, (syncedClients.get(qc) ?? 0) + 1)
  if (!channel) {
    channel = openChannel()
    channel?.addEventListener('message', onSessionMessage)
  }
  return () => {
    const left = (syncedClients.get(qc) ?? 1) - 1
    if (left > 0) syncedClients.set(qc, left)
    else syncedClients.delete(qc)
    if (syncedClients.size === 0 && channel) {
      channel.removeEventListener('message', onSessionMessage)
      channel.close()
      channel = null
    }
  }
}

export interface PineSessionState {
  /**
   * `disabled` outside `api` mode. `error`: Pine could not be asked (5xx, network error) and nothing is known yet, so the
   * session is unknown: neither signed in nor signed out. A failed refetch keeps the last known state instead.
   */
  status: 'disabled' | 'loading' | 'signed_out' | 'signed_in' | 'error'
  session: PineSession | null
  error: Error | null
  refresh(): Promise<void>
}

/**
 * The backend session: GET /api/v1/auth/session (401 → signed out). Asked again when the window regains focus, when the
 * browser comes back online and when another tab of this browser announces a change.
 */
export function usePineSession(): PineSessionState {
  const { api } = usePine()
  const qc = useQueryClient()
  const q = useQuery<PineSession | null, Error>({
    queryKey: pineKeys.session(),
    enabled: api !== null,
    staleTime: 60_000,
    retry: (count, error) => !(error instanceof PineBackendError && error.status > 0 && error.status < 500) && count < 2,
    // A failed check is not refetched by every component that mounts afterwards: on /account that put the query back
    // to loading, which unmounted and remounted the sign-in form, once a second forever. Focus, reconnect and "Try
    // again" ask again.
    retryOnMount: false,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    queryFn: async () => {
      try {
        return await requireApi(api).get('/api/v1/auth/session', pineSessionSchema)
      } catch (e) {
        if (e instanceof PineBackendError && e.status === 401) return null
        throw e
      }
    },
  })
  useEffect(() => (api === null ? undefined : subscribeSessionSync(qc)), [api, qc])
  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: pineKeys.session() })
  }, [qc])
  let status: PineSessionState['status']
  if (api === null) status = 'disabled'
  else if (q.isPending) status = 'loading'
  else if (q.data === undefined) status = 'error'
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
      qc.removeQueries({ predicate: (query) => isUserQuery(query.queryKey) })
      qc.setQueryData(pineKeys.session(), session)
      announceSessionChange()
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

export interface SignOutOptions {
  /** End every session of the account, not only this browser's. */
  everywhere?: boolean
  /**
   * Drop the session in this browser even when Pine did not confirm the sign-out (the error is still thrown). For the
   * wallet-switch sign-out (SEC-AUTH-13), where the session must not stay in use with another wallet.
   */
  force?: boolean
}

/**
 * POST /api/v1/auth/logout (`everywhere` ends every session of the account). The session is dropped in this browser
 * only once Pine confirmed it ended (2xx, or 401: it had already ended). When the request fails the session cookie is
 * still valid, so the user stays signed in here and the error is thrown: showing "signed out" would be false (the
 * HttpOnly cookie cannot be cleared by script). With `force`, or when the wallet has switched to another account than
 * the session's, the session is dropped here anyway and the error still thrown.
 */
export function useSignOut(): (opts?: SignOutOptions) => Promise<void> {
  const { api } = usePine()
  const qc = useQueryClient()
  const wallet = useWallet()
  const selected = wallet.isConnected && !wallet.isReconnecting ? wallet.address?.toLowerCase() : undefined
  const selectedRef = useRef(selected)
  useEffect(() => {
    selectedRef.current = selected
  })
  return useCallback(
    async (opts?: SignOutOptions) => {
      const dropLocal = () => {
        dropSession(qc)
        announceSessionChange()
      }
      try {
        await requireApi(api).request('POST', '/api/v1/auth/logout', emptySchema, { body: opts?.everywhere ? { everywhere: true } : {} })
      } catch (e) {
        const bound = qc.getQueryData<PineSession | null>(pineKeys.session())?.wallet.toLowerCase()
        const switched = Boolean(bound && selectedRef.current && bound !== selectedRef.current)
        const gone = e instanceof PineBackendError && e.status === 401
        if (gone || opts?.force === true || switched) dropLocal()
        if (!gone) throw e
        // This session had already ended, so Pine could not tell which other sessions to end.
        if (opts?.everywhere) throw new Error('This browser’s Pine session had already ended, so your other sessions were not signed out. Sign in again, then sign out everywhere.')
        return
      }
      dropLocal()
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
      window.location.assign(githubConsentUrl(checkGitHubAuthorizationUrl(authorizationUrl), devGitHubOrigin()))
    } catch (e) {
      handleSessionGone(qc, e)
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
      throw e
    }
  }, [api, qc])

  const unlink = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      await requireApi(api).request('DELETE', '/api/v1/auth/github', emptySchema)
      dropSession(qc)
      announceSessionChange()
    } catch (e) {
      handleSessionGone(qc, e)
      setError(e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      setBusy(false)
    }
  }, [api, qc])

  return { link, unlink, busy, error }
}
