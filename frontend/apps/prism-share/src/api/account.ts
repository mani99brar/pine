/**
 * `/api/account/*` in the browser. Mirrors the mock-mode cookie backend of `createAccountHandler`
 * (packages/server/src/siwe.ts) with the same routes, validation and response shapes, but keeps the
 * stored account in localStorage instead of an HMAC-signed cookie.
 */
import { getAddress, isAddress } from 'viem'
import type { Account, AccountPreferences, Address, LinkedWallet } from '@pine/core'
import { SUPPORTED_CHAIN_IDS } from '@pine/core/chains'
import { DEMO_WALLET_ADDRESS, readPineEnv } from '@pine/data'
import { preferencesPatchSchema } from '@pine/server/siwe'
import { freshStored, linkWallet, setPrimary, toAccount, unlinkWallet, type StoredAccount } from '@pine-server-src/account-store'
import { auth, type PineSessionUser } from './session'
import { errorJson, json } from './respond'
import { readLocal, removeLocal, writeLocal } from './storage'

const DEMO_WALLET_LABEL = 'Demo wallet (simulated signature)'
const keyFor = (login: string) => `pine-prism-share:account:${login.toLowerCase()}`

function readStored(login: string): StoredAccount {
  const s = readLocal<StoredAccount>(keyFor(login))
  if (s && s.v === 1 && s.login === login) return s
  return freshStored(login, readPineEnv().defaultChainId)
}

function save(user: PineSessionUser, next: StoredAccount): Account {
  writeLocal(keyFor(user.login), next)
  return toAccount(user, next)
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

function shouldBePrimary(stored: StoredAccount, address: string): boolean {
  if (stored.wallets.length === 0) return true
  return stored.wallets.some((w) => w.address.toLowerCase() === address.toLowerCase() && w.primary)
}

function unauthorized(): Response {
  return errorJson(401, 'unauthorized', 'Sign in first.', { hint: 'Use GitHub sign-in (or demo sign-in in demo mode).' })
}

function notFound(route: string): Response {
  return errorJson(404, 'not_found', `Unknown account route: /${route}`, {
    hint: 'GET me|nonce|export|api-token · POST siwe/verify|wallets/demo|wallets/:address/primary · PATCH preferences · DELETE wallets/:address|me',
  })
}

async function readBody(req: Request): Promise<unknown> {
  const text = await req.text()
  if (!text) return {}
  return JSON.parse(text)
}

/** The export document, built synchronously (also used by the export override in src/shims/account-data.ts). */
export function buildAccountExport(user: PineSessionUser): Record<string, unknown> {
  return {
    exportedAt: new Date().toISOString(),
    storage: 'browser-localStorage (static preview)',
    account: toAccount(user, readStored(user.login)),
    notes: [
      'Drafts, in-progress publications and transaction progress are stored in this browser (localStorage keys pine:*).',
      'This static preview has no server: the account lives only in this browser.',
    ],
  }
}

export async function handleAccount(req: Request, segs: string[]): Promise<Response> {
  const method = req.method.toUpperCase()
  const route = segs.join('/')
  const session = await auth()
  const user = session?.user ?? null

  if (method === 'GET') {
    if (route === 'nonce') {
      if (!user) return unauthorized()
      const bytes = crypto.getRandomValues(new Uint8Array(12))
      const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
      return json({ nonce, expiresAt: new Date(Date.now() + 600_000).toISOString() })
    }
    if (!user) return unauthorized()
    if (route === 'api-token') {
      return json({ token: `pine1.static-preview.${user.login}`, expiresAt: new Date(Date.now() + 600_000).toISOString() })
    }
    if (route === 'me') return json({ account: toAccount(user, readStored(user.login)) })
    if (route === 'export') {
      return new Response(JSON.stringify(buildAccountExport(user), null, 2), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="pine-account-${user.login}.json"`,
          'cache-control': 'private, no-store',
        },
      })
    }
    return notFound(route)
  }

  if (!user) return unauthorized()
  const stored = readStored(user.login)

  if (method === 'POST') {
    const [a, b, c] = segs
    if (a === 'siwe' && b === 'verify' && segs.length === 2) {
      return errorJson(403, 'forbidden', 'Sign-In with Ethereum needs a real wallet and a server. In this static preview, link the simulated demo wallet instead.')
    }
    if (a === 'wallets' && b === 'demo' && segs.length === 2) {
      let body: { address?: unknown; chainId?: unknown } = {}
      try {
        body = (await readBody(req)) as typeof body
      } catch {
        body = {}
      }
      const address = typeof body.address === 'string' ? body.address : DEMO_WALLET_ADDRESS
      if (address.toLowerCase() !== DEMO_WALLET_ADDRESS.toLowerCase()) {
        return errorJson(400, 'bad_request', 'Only the simulated demo wallet can be linked without a signature.')
      }
      const chainId = typeof body.chainId === 'number' && SUPPORTED_CHAIN_IDS.includes(body.chainId) ? body.chainId : readPineEnv().defaultChainId
      const wallet: LinkedWallet = {
        address: getAddress(DEMO_WALLET_ADDRESS),
        chainId,
        verifiedAt: nowIso(),
        label: DEMO_WALLET_LABEL,
        primary: shouldBePrimary(stored, DEMO_WALLET_ADDRESS),
      }
      const account = save(user, linkWallet(stored, wallet))
      const linked = account.wallets.find((w) => w.address.toLowerCase() === wallet.address.toLowerCase()) ?? wallet
      return json({ account, wallet: linked })
    }
    if (a === 'wallets' && b && c === 'primary' && segs.length === 3) {
      if (!isAddress(b)) return errorJson(400, 'bad_request', 'Invalid address.')
      const next = setPrimary(stored, getAddress(b))
      if (!next) return errorJson(404, 'not_found', 'That wallet is not linked to this account.')
      return json({ account: save(user, next) })
    }
    return notFound(route)
  }

  if (method === 'PATCH') {
    if (route !== 'preferences') return notFound(route)
    let body: unknown
    try {
      body = await readBody(req)
    } catch {
      return errorJson(400, 'bad_request', 'Body must be JSON.')
    }
    const parsed = preferencesPatchSchema.safeParse(body)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return errorJson(400, 'validation', issue ? `${issue.path.join('.') || 'preferences'}: ${issue.message}` : 'Invalid preferences.')
    }
    const patch = { ...parsed.data } as Partial<AccountPreferences>
    if (patch.notificationEmail === '') patch.notificationEmail = undefined
    return json({ account: save(user, { ...stored, preferences: { ...stored.preferences, ...patch } }) })
  }

  if (method === 'DELETE') {
    const [a, b] = segs
    if (a === 'wallets' && b && segs.length === 2) {
      if (!isAddress(b)) return errorJson(400, 'bad_request', 'Invalid address.')
      return json({ account: save(user, unlinkWallet(stored, getAddress(b) as Address)) })
    }
    if ((a === 'me' && segs.length === 1) || segs.length === 0) {
      removeLocal(keyFor(user.login))
      return json({ deleted: true })
    }
    return notFound(route)
  }

  return errorJson(405, 'method_not_allowed', `${method} is not supported on /api/account/${route}.`)
}
