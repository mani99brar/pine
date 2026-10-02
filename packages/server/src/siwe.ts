/**
 * Account + wallet linking: `src/app/api/account/[...path]/route.ts`
 *
 *   import { auth } from '@/auth'
 *   import { createAccountHandler } from '@pine/server/siwe'
 *   export const { GET, POST, PATCH, DELETE } = createAccountHandler(auth)
 *
 * Routes:
 *   GET    me                       → { account }                       (401 when signed out)
 *   GET    nonce                    → { nonce } + httpOnly nonce cookie (10 min, single use)
 *   POST   siwe/verify              { message, signature } → { account, wallet }
 *   POST   wallets/demo             { address } → { account, wallet }    (demo mode only; simulated, no signature)
 *   DELETE wallets/:address         → { account }
 *   POST   wallets/:address/primary → { account }
 *   PATCH  preferences              Partial<AccountPreferences> → { account }
 *   GET    export                   → JSON download of everything stored about the account
 *   DELETE me                       → removes stored account data (wallet links, preferences)
 *
 * Storage: mock/envio mode keeps the account in an HMAC-signed httpOnly cookie (see account-store.ts);
 * rest mode forwards to the REST API through `createAccountStore(env)` from @pine/data.
 */
import { createPublicClient, getAddress, http, isAddress, isHex, verifyMessage, type Chain } from 'viem'
import { generateSiweNonce, parseSiweMessage, validateSiweMessage, verifySiweMessage } from 'viem/siwe'
import { gnosis, mainnet, sepolia } from 'viem/chains'
import { z } from 'zod'
import type { Account, AccountPreferences, Address, LinkedWallet } from '@pine/core'
import { SUPPORTED_CHAIN_IDS } from '@pine/core/chains'
import { createAccountStore, DEMO_WALLET_ADDRESS } from '@pine/data'
import { demoAllowed, readServerEnv, requestHost, type ServerEnv } from './env'
import {
  errorResponse,
  isHttps,
  json,
  pathSegments,
  PRIVATE_NO_STORE,
  readCookie,
  serializeCookie,
  withCookies,
  type CatchAllContext,
} from './http'
import {
  accountCookie,
  clearAccountCookie,
  freshStored,
  linkWallet,
  readStoredAccount,
  setPrimary,
  signValue,
  toAccount,
  unlinkWallet,
  unsignValue,
  type StoredAccount,
} from './account-store'
import { getSessionUser, type PineAuthLike, type PineSessionUser } from './session'

export const NONCE_COOKIE = 'pine.siwe-nonce'
const NONCE_TTL_SECONDS = 600
/** Reject SIWE messages issued too long ago (clock skew + time to sign). */
const MAX_MESSAGE_AGE_MS = 15 * 60_000
const DEMO_WALLET_LABEL = 'Demo wallet (simulated signature)'

const VIEM_CHAINS: Record<number, Chain> = { 100: gnosis, 1: mainnet, 11155111: sepolia }

export const preferencesPatchSchema = z
  .object({
    defaultChainId: z
      .number()
      .int()
      .refine((id) => SUPPORTED_CHAIN_IDS.includes(id), 'Unsupported chain.'),
    defaultSpendingLimit: z
      .string()
      .regex(/^\d+(\.\d{1,18})?$/, 'Spending limit must be a decimal amount, e.g. "50" or "12.5".')
      .max(40),
    notifyOnEvidence: z.boolean(),
    notifyOnAnswer: z.boolean(),
    notifyOnDeadline: z.boolean(),
    notificationEmail: z.union([z.literal(''), z.string().email('Enter a valid email address.').max(254)]),
    displayCurrency: z.enum(['collateral', 'usd']),
  })
  .partial()
  .strict()

export interface AccountHandlerOptions {
  /** Inject a public client factory for smart-contract wallet verification (tests). */
  publicClientFor?: (chainId: number) => Parameters<typeof verifySiweMessage>[0] | undefined
}

/** Per-request account backend: signed cookie (mock/envio) or REST API (rest). */
interface Backend {
  me(): Promise<Account>
  link(wallet: LinkedWallet): Promise<Account>
  unlink(address: Address): Promise<Account>
  primary(address: Address): Promise<Account | null>
  preferences(patch: Partial<AccountPreferences>): Promise<Account>
  export(): Promise<Record<string, unknown>>
  remove(): Promise<void>
  cookies: string[]
}

async function cookieBackend(req: Request, user: PineSessionUser, env: ServerEnv): Promise<Backend> {
  let stored: StoredAccount = (await readStoredAccount(req, user.login, env.authSecret)) ?? freshStored(user.login, env.defaultChainId)
  const cookies: string[] = []
  const save = async (next: StoredAccount) => {
    stored = next
    cookies.push(await accountCookie(req, next, env.authSecret))
    return toAccount(user, next)
  }
  return {
    cookies,
    async me() {
      return toAccount(user, stored)
    },
    link: (wallet) => save(linkWallet(stored, wallet)),
    unlink: (address) => save(unlinkWallet(stored, address)),
    async primary(address) {
      const next = setPrimary(stored, address)
      return next ? save(next) : null
    },
    preferences: (patch) => save({ ...stored, preferences: { ...stored.preferences, ...patch } }),
    async export() {
      return {
        exportedAt: new Date().toISOString(),
        storage: 'signed-cookie',
        account: toAccount(user, stored),
        notes: [
          'Drafts, in-progress publications and transaction progress are stored in this browser (localStorage keys pine:*).',
          'Pine never stores your GitHub access token outside the encrypted session cookie.',
        ],
      }
    },
    async remove() {
      cookies.push(clearAccountCookie(req))
    },
  }
}

function restBackend(user: PineSessionUser, env: ServerEnv): Backend {
  const store = createAccountStore(env)
  const gh = { login: user.login, id: user.githubId, name: user.name ?? null, avatarUrl: user.avatarUrl, htmlUrl: user.htmlUrl }
  const ensure = async () => (await store.get(user.login)) ?? store.upsertFromGitHub(gh, user.scopes, user.demo)
  return {
    cookies: [],
    me: ensure,
    async link(wallet) {
      await ensure()
      return store.linkWallet(user.login, wallet)
    },
    async unlink(address) {
      await ensure()
      return store.unlinkWallet(user.login, address)
    },
    async primary(address) {
      const acct = await ensure()
      if (!acct.wallets.some((w) => w.address.toLowerCase() === address.toLowerCase())) return null
      return store.setPrimaryWallet(user.login, address)
    },
    async preferences(patch) {
      await ensure()
      return store.updatePreferences(user.login, patch)
    },
    export: () => store.exportData(user.login),
    remove: () => store.remove(user.login),
  }
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return true // non-browser clients; cookies are SameSite=Lax
  try {
    return new URL(origin).host === requestHost(req)
  } catch {
    return false
  }
}

async function readBody(req: Request): Promise<unknown> {
  const text = await req.text()
  if (text.length > 16_384) throw new Error('Request body too large.')
  if (!text) return {}
  return JSON.parse(text)
}

export interface VerifySiweInput {
  message: string
  signature: string
  expectedDomain: string
  expectedNonce: string | null
  now?: Date
  publicClientFor?: AccountHandlerOptions['publicClientFor']
}

export type VerifySiweResult =
  | { ok: true; address: Address; chainId: number }
  | { ok: false; code: string; message: string; status: number }

/** Verifies an EIP-4361 message: format, domain, nonce, expiry, then the signature (EOA, then ERC-1271/6492). */
export async function verifySiwe(input: VerifySiweInput): Promise<VerifySiweResult> {
  const now = input.now ?? new Date()
  if (!input.expectedNonce) {
    return { ok: false, status: 400, code: 'nonce_missing', message: 'No sign-in nonce found or it expired. Request a new one and sign again.' }
  }
  if (!isHex(input.signature)) return { ok: false, status: 400, code: 'bad_request', message: 'Signature must be hex.' }
  let parsed: ReturnType<typeof parseSiweMessage>
  try {
    parsed = parseSiweMessage(input.message)
  } catch {
    return { ok: false, status: 400, code: 'bad_message', message: 'Malformed Sign-In with Ethereum message.' }
  }
  if (!parsed.address || !isAddress(parsed.address) || !parsed.nonce || !parsed.domain || !parsed.chainId) {
    return { ok: false, status: 400, code: 'bad_message', message: 'The message is missing its address, domain, chain or nonce.' }
  }
  if (parsed.nonce !== input.expectedNonce) {
    return { ok: false, status: 400, code: 'nonce_mismatch', message: 'The message nonce does not match. Request a new nonce and sign again.' }
  }
  if (parsed.domain !== input.expectedDomain) {
    return { ok: false, status: 400, code: 'domain_mismatch', message: `The message was created for ${parsed.domain}, not ${input.expectedDomain}.` }
  }
  if (!parsed.expirationTime) {
    return { ok: false, status: 400, code: 'bad_message', message: 'The message must include an expiration time.' }
  }
  if (!validateSiweMessage({ message: parsed, domain: input.expectedDomain, nonce: input.expectedNonce, time: now })) {
    return { ok: false, status: 400, code: 'expired', message: 'The sign-in message has expired or is not yet valid.' }
  }
  if (parsed.issuedAt && now.getTime() - parsed.issuedAt.getTime() > MAX_MESSAGE_AGE_MS) {
    return { ok: false, status: 400, code: 'expired', message: 'The sign-in message is too old. Sign a new one.' }
  }
  const signature = input.signature as `0x${string}`
  let valid = false
  try {
    valid = await verifyMessage({ address: parsed.address, message: input.message, signature })
  } catch {
    valid = false
  }
  if (!valid) {
    // Smart-contract wallets (ERC-1271 / ERC-6492) need an RPC call.
    const client = input.publicClientFor?.(parsed.chainId) ?? defaultPublicClient(parsed.chainId)
    if (client) {
      try {
        valid = await verifySiweMessage(client, {
          message: input.message,
          signature,
          domain: input.expectedDomain,
          nonce: input.expectedNonce,
          time: now,
        })
      } catch {
        valid = false
      }
    }
  }
  if (!valid) return { ok: false, status: 401, code: 'bad_signature', message: 'The signature does not match the address in the message.' }
  return { ok: true, address: getAddress(parsed.address), chainId: parsed.chainId }
}

function defaultPublicClient(chainId: number) {
  const chain = VIEM_CHAINS[chainId]
  if (!chain) return undefined
  const override = chainId === 100 ? process.env.NEXT_PUBLIC_RPC_URL_100 : chainId === 1 ? process.env.NEXT_PUBLIC_RPC_URL_1 : process.env.NEXT_PUBLIC_RPC_URL_11155111
  return createPublicClient({ chain, transport: http(override || undefined, { timeout: 8_000 }) })
}

export function createAccountHandler(auth: PineAuthLike, opts: AccountHandlerOptions = {}) {
  async function context(req: Request) {
    const env = readServerEnv()
    const user = await getSessionUser(auth, req)
    return { env, user }
  }

  async function backendFor(req: Request, user: PineSessionUser, env: ServerEnv): Promise<Backend> {
    return env.dataSource === 'rest' ? restBackend(user, env) : cookieBackend(req, user, env)
  }

  function unauthorized(): Response {
    return errorResponse(401, 'unauthorized', 'Sign in first.', { hint: 'Use GitHub sign-in (or demo sign-in in demo mode).' })
  }

  function respond(body: unknown, backend: Backend, extraCookies: string[] = []): Response {
    return withCookies(json(body, { cache: PRIVATE_NO_STORE }), [...backend.cookies, ...extraCookies])
  }

  async function GET(req: Request, ctx?: CatchAllContext): Promise<Response> {
    const segs = await pathSegments(req, ctx, '/api/account/')
    const route = segs.join('/')
    const { env, user } = await context(req)
    try {
      if (route === 'nonce') {
        if (!user) return unauthorized()
        const nonce = generateSiweNonce()
        const exp = Date.now() + NONCE_TTL_SECONDS * 1000
        const value = await signValue(`${nonce}:${exp}:${user.login}`, env.authSecret)
        const cookie = serializeCookie(NONCE_COOKIE, value, {
          maxAge: NONCE_TTL_SECONDS,
          httpOnly: true,
          secure: isHttps(req),
          sameSite: 'Strict',
        })
        return withCookies(json({ nonce, expiresAt: new Date(exp).toISOString() }, { cache: PRIVATE_NO_STORE }), [cookie])
      }
      if (!user) return unauthorized()
      const backend = await backendFor(req, user, env)
      if (route === 'me') return respond({ account: await backend.me() }, backend)
      if (route === 'export') {
        const data = await backend.export()
        const res = new Response(JSON.stringify(data, null, 2), {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="pine-account-${user.login}.json"`,
            'cache-control': PRIVATE_NO_STORE,
          },
        })
        return withCookies(res, backend.cookies)
      }
      return notFound(route)
    } catch (e) {
      return serverError(e)
    }
  }

  async function POST(req: Request, ctx?: CatchAllContext): Promise<Response> {
    const segs = await pathSegments(req, ctx, '/api/account/')
    if (!sameOrigin(req)) return errorResponse(403, 'forbidden', 'Cross-origin request rejected.')
    const { env, user } = await context(req)
    if (!user) return unauthorized()
    try {
      const backend = await backendFor(req, user, env)
      const [a, b, c] = segs

      if (a === 'siwe' && b === 'verify' && segs.length === 2) {
        let body: { message?: unknown; signature?: unknown }
        try {
          body = (await readBody(req)) as typeof body
        } catch {
          return errorResponse(400, 'bad_request', 'Body must be JSON: { message, signature }.')
        }
        if (typeof body.message !== 'string' || typeof body.signature !== 'string' || body.message.length > 4000) {
          return errorResponse(400, 'bad_request', 'Body must be JSON: { message, signature }.')
        }
        const rawNonce = await unsignValue(readCookie(req, NONCE_COOKIE), env.authSecret)
        let expectedNonce: string | null = null
        if (rawNonce) {
          const [nonce, exp, login] = rawNonce.split(':')
          if (nonce && Number(exp) > Date.now() && login === user.login) expectedNonce = nonce
        }
        const clearNonce = serializeCookie(NONCE_COOKIE, '', { maxAge: 0, httpOnly: true, secure: isHttps(req), sameSite: 'Strict' })
        const result = await verifySiwe({
          message: body.message,
          signature: body.signature,
          expectedDomain: requestHost(req),
          expectedNonce,
          publicClientFor: opts.publicClientFor,
        })
        if (!result.ok) {
          return withCookies(errorResponse(result.status, result.code, result.message), result.code === 'nonce_mismatch' ? [] : [clearNonce])
        }
        const wallet: LinkedWallet = {
          address: result.address,
          chainId: result.chainId,
          verifiedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          primary: false,
        }
        const account = await backend.link(wallet)
        const linked = account.wallets.find((w) => w.address.toLowerCase() === result.address.toLowerCase()) ?? wallet
        return respond({ account, wallet: linked }, backend, [clearNonce])
      }

      if (a === 'wallets' && b === 'demo' && segs.length === 2) {
        if (!demoAllowed(env)) return errorResponse(403, 'forbidden', 'Demo wallet linking is only available in demo mode.')
        let body: { address?: unknown; chainId?: unknown }
        try {
          body = (await readBody(req)) as typeof body
        } catch {
          body = {}
        }
        const address = typeof body.address === 'string' ? body.address : DEMO_WALLET_ADDRESS
        if (address.toLowerCase() !== DEMO_WALLET_ADDRESS.toLowerCase()) {
          return errorResponse(400, 'bad_request', 'Only the simulated demo wallet can be linked without a signature.')
        }
        const chainId = typeof body.chainId === 'number' && SUPPORTED_CHAIN_IDS.includes(body.chainId) ? body.chainId : env.defaultChainId
        const wallet: LinkedWallet = {
          address: getAddress(DEMO_WALLET_ADDRESS),
          chainId,
          verifiedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          label: DEMO_WALLET_LABEL,
          primary: false,
        }
        const account = await backend.link(wallet)
        const linked = account.wallets.find((w) => w.address.toLowerCase() === wallet.address.toLowerCase()) ?? wallet
        return respond({ account, wallet: linked }, backend)
      }

      if (a === 'wallets' && b && c === 'primary' && segs.length === 3) {
        if (!isAddress(b)) return errorResponse(400, 'bad_request', 'Invalid address.')
        const account = await backend.primary(getAddress(b))
        if (!account) return errorResponse(404, 'not_found', 'That wallet is not linked to this account.')
        return respond({ account }, backend)
      }
      return notFound(segs.join('/'))
    } catch (e) {
      return serverError(e)
    }
  }

  async function PATCH(req: Request, ctx?: CatchAllContext): Promise<Response> {
    const segs = await pathSegments(req, ctx, '/api/account/')
    if (!sameOrigin(req)) return errorResponse(403, 'forbidden', 'Cross-origin request rejected.')
    const { env, user } = await context(req)
    if (!user) return unauthorized()
    if (segs.join('/') !== 'preferences') return notFound(segs.join('/'))
    try {
      let body: unknown
      try {
        body = await readBody(req)
      } catch {
        return errorResponse(400, 'bad_request', 'Body must be JSON.')
      }
      const parsed = preferencesPatchSchema.safeParse(body)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        return errorResponse(400, 'validation', issue ? `${issue.path.join('.') || 'preferences'}: ${issue.message}` : 'Invalid preferences.')
      }
      const backend = await backendFor(req, user, env)
      const patch = { ...parsed.data } as Partial<AccountPreferences>
      if (patch.notificationEmail === '') patch.notificationEmail = undefined
      return respond({ account: await backend.preferences(patch) }, backend)
    } catch (e) {
      return serverError(e)
    }
  }

  async function DELETE(req: Request, ctx?: CatchAllContext): Promise<Response> {
    const segs = await pathSegments(req, ctx, '/api/account/')
    if (!sameOrigin(req)) return errorResponse(403, 'forbidden', 'Cross-origin request rejected.')
    const { env, user } = await context(req)
    if (!user) return unauthorized()
    try {
      const backend = await backendFor(req, user, env)
      const [a, b] = segs
      if (a === 'wallets' && b && segs.length === 2) {
        if (!isAddress(b)) return errorResponse(400, 'bad_request', 'Invalid address.')
        return respond({ account: await backend.unlink(getAddress(b)) }, backend)
      }
      if ((a === 'me' && segs.length === 1) || segs.length === 0) {
        await backend.remove()
        return respond({ deleted: true }, backend)
      }
      return notFound(segs.join('/'))
    } catch (e) {
      return serverError(e)
    }
  }

  return { GET, POST, PATCH, DELETE }
}

function notFound(route: string): Response {
  return errorResponse(404, 'not_found', `Unknown account route: /${route}`, {
    hint: 'GET me|nonce|export · POST siwe/verify|wallets/demo|wallets/:address/primary · PATCH preferences · DELETE wallets/:address|me',
  })
}

function serverError(e: unknown): Response {
  const err = e as { code?: string; message?: string } | undefined
  if (err?.code === 'unauthorized') return errorResponse(401, 'unauthorized', err.message ?? 'Unauthorized.')
  if (err?.code === 'not_found') return errorResponse(404, 'not_found', err.message ?? 'Not found.')
  return errorResponse(500, 'server_error', err?.message ?? 'Account request failed.')
}
