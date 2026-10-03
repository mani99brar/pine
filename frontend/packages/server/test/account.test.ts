import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'
import { DEMO_WALLET_ADDRESS } from '@pine/data'
import type { Account, LinkedWallet } from '@pine/core'
import { createAccountHandler, verifySiwe } from '../src/siwe'
import { mintApiToken, verifyApiToken } from '../src/account-store'
import { readServerEnv } from '../src/env'
import { cookieHeader, ctx, req, signedIn, signedOut } from './helpers'

// Well-known test key (anvil #0). Never holds funds.
const wallet = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const DOMAIN = 'localhost:3001'

const noRpc = () => undefined

async function nonceFlow(handler: ReturnType<typeof createAccountHandler>) {
  const res = await handler.GET(req('/api/account/nonce'), ctx(['nonce']))
  expect(res.status).toBe(200)
  const { nonce } = (await res.json()) as { nonce: string }
  return { nonce, cookie: cookieHeader(res) }
}

function message(nonce: string, overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {}) {
  const now = new Date()
  return createSiweMessage({
    domain: DOMAIN,
    address: wallet.address,
    statement: 'Link this wallet to your Pine account.',
    uri: `http://${DOMAIN}`,
    version: '1',
    chainId: 100,
    nonce,
    issuedAt: now,
    expirationTime: new Date(now.getTime() + 10 * 60_000),
    ...overrides,
  })
}

async function verify(handler: ReturnType<typeof createAccountHandler>, body: unknown, cookie: string) {
  return handler.POST(
    req('/api/account/siwe/verify', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: `http://${DOMAIN}` },
      body: JSON.stringify(body),
    }),
    ctx(['siwe', 'verify']),
  )
}

describe('account handler', () => {
  it('requires a session', async () => {
    const handler = createAccountHandler(signedOut)
    expect((await handler.GET(req('/api/account/me'), ctx(['me']))).status).toBe(401)
    expect((await handler.GET(req('/api/account/nonce'), ctx(['nonce']))).status).toBe(401)
  })

  it('GET me returns a fresh account with default preferences', async () => {
    const handler = createAccountHandler(signedIn())
    const res = await handler.GET(req('/api/account/me'), ctx(['me']))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const { account } = (await res.json()) as { account: Account }
    expect(account.github.login).toBe('mara-okafor')
    expect(account.wallets).toEqual([])
    expect(account.preferences.defaultSpendingLimit).toBe('50')
    expect(account.demo).toBe(true)
  })

  it('SIWE happy path links the wallet (signed cookie persists it)', async () => {
    const handler = createAccountHandler(signedIn(), { publicClientFor: noRpc })
    const { nonce, cookie } = await nonceFlow(handler)
    expect(cookie).toMatch(/pine\.siwe-nonce=/)
    const msg = message(nonce)
    const signature = await wallet.signMessage({ message: msg })
    const res = await verify(handler, { message: msg, signature }, cookie)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { account: Account; wallet: LinkedWallet }
    expect(body.wallet.address).toBe(wallet.address)
    expect(body.wallet.primary).toBe(true)
    expect(body.wallet.chainId).toBe(100)
    expect(body.account.wallets).toHaveLength(1)

    // Nonce is single-use (cleared) and the account cookie carries the link.
    const after = cookieHeader(res)
    expect(after).toMatch(/pine\.account=/)
    expect(after).not.toMatch(/pine\.siwe-nonce=/)
    const me = await handler.GET(req('/api/account/me', { headers: { cookie: after } }), ctx(['me']))
    const { account } = (await me.json()) as { account: Account }
    expect(account.wallets.map((w) => w.address)).toEqual([wallet.address])

    // Replaying the same message without a fresh nonce fails.
    const replay = await verify(handler, { message: msg, signature }, after)
    expect(replay.status).toBe(400)
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe('nonce_missing')
  })

  it('rejects a bad nonce', async () => {
    const handler = createAccountHandler(signedIn(), { publicClientFor: noRpc })
    const { cookie } = await nonceFlow(handler)
    const msg = message('differentNonce123')
    const signature = await wallet.signMessage({ message: msg })
    const res = await verify(handler, { message: msg, signature }, cookie)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('nonce_mismatch')
  })

  it('rejects a wrong domain, an expired message and a forged signature', async () => {
    const handler = createAccountHandler(signedIn(), { publicClientFor: noRpc })

    let flow = await nonceFlow(handler)
    let msg = message(flow.nonce, { domain: 'evil.example' })
    let res = await verify(handler, { message: msg, signature: await wallet.signMessage({ message: msg }) }, flow.cookie)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('domain_mismatch')

    flow = await nonceFlow(handler)
    const past = new Date(Date.now() - 60 * 60_000)
    msg = message(flow.nonce, { issuedAt: past, expirationTime: new Date(past.getTime() + 60_000) })
    res = await verify(handler, { message: msg, signature: await wallet.signMessage({ message: msg }) }, flow.cookie)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('expired')

    flow = await nonceFlow(handler)
    msg = message(flow.nonce)
    const other = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
    res = await verify(handler, { message: msg, signature: await other.signMessage({ message: msg }) }, flow.cookie)
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_signature')
  })

  it('a nonce issued to another login is not accepted', async () => {
    const mara = createAccountHandler(signedIn(), { publicClientFor: noRpc })
    const other = createAccountHandler(signedIn({ login: 'someone-else' }), { publicClientFor: noRpc })
    const { nonce, cookie } = await nonceFlow(mara)
    const msg = message(nonce)
    const res = await verify(other, { message: msg, signature: await wallet.signMessage({ message: msg }) }, cookie)
    expect(res.status).toBe(400)
  })

  it('verifySiwe is usable standalone', async () => {
    const msg = message('abcdef12345678')
    const r = await verifySiwe({
      message: msg,
      signature: await wallet.signMessage({ message: msg }),
      expectedDomain: DOMAIN,
      expectedNonce: 'abcdef12345678',
      publicClientFor: noRpc,
    })
    expect(r).toEqual({ ok: true, address: wallet.address, chainId: 100 })
  })

  it('demo wallet linking, primary, preferences, export, unlink and delete', async () => {
    const handler = createAccountHandler(signedIn())
    const origin = { origin: `http://${DOMAIN}` }
    const demo = await handler.POST(
      req('/api/account/wallets/demo', { method: 'POST', headers: { ...origin, 'content-type': 'application/json' }, body: JSON.stringify({ address: DEMO_WALLET_ADDRESS }) }),
      ctx(['wallets', 'demo']),
    )
    expect(demo.status).toBe(200)
    const linked = (await demo.json()) as { wallet: LinkedWallet }
    expect(linked.wallet.label).toMatch(/demo/i)
    let cookie = cookieHeader(demo)

    const prefs = await handler.PATCH(
      req('/api/account/preferences', { method: 'PATCH', headers: { cookie, ...origin }, body: JSON.stringify({ defaultSpendingLimit: '120', notifyOnAnswer: false }) }),
      ctx(['preferences']),
    )
    expect(prefs.status).toBe(200)
    cookie = cookieHeader(demo, prefs)
    const { account } = (await prefs.json()) as { account: Account }
    expect(account.preferences.defaultSpendingLimit).toBe('120')
    expect(account.preferences.notifyOnAnswer).toBe(false)
    expect(account.wallets).toHaveLength(1)

    const badPrefs = await handler.PATCH(
      req('/api/account/preferences', { method: 'PATCH', headers: { cookie, ...origin }, body: JSON.stringify({ defaultSpendingLimit: '-5' }) }),
      ctx(['preferences']),
    )
    expect(badPrefs.status).toBe(400)

    const primary = await handler.POST(
      req(`/api/account/wallets/${DEMO_WALLET_ADDRESS}/primary`, { method: 'POST', headers: { cookie, ...origin } }),
      ctx(['wallets', DEMO_WALLET_ADDRESS, 'primary']),
    )
    expect(primary.status).toBe(200)

    const exp = await handler.GET(req('/api/account/export', { headers: { cookie } }), ctx(['export']))
    expect(exp.status).toBe(200)
    expect(exp.headers.get('content-disposition')).toMatch(/attachment; filename="pine-account-mara-okafor\.json"/)
    expect(((await exp.json()) as { account: Account }).account.preferences.defaultSpendingLimit).toBe('120')

    const unlink = await handler.DELETE(
      req(`/api/account/wallets/${DEMO_WALLET_ADDRESS}`, { method: 'DELETE', headers: { cookie, ...origin } }),
      ctx(['wallets', DEMO_WALLET_ADDRESS]),
    )
    expect(((await unlink.json()) as { account: Account }).account.wallets).toEqual([])

    const del = await handler.DELETE(req('/api/account/me', { method: 'DELETE', headers: { cookie, ...origin } }), ctx(['me']))
    expect(del.status).toBe(200)
    expect(del.headers.getSetCookie().join(';')).toMatch(/pine\.account=;.*Max-Age=0/)
  })

  it('rejects cross-origin writes and tampered cookies', async () => {
    const handler = createAccountHandler(signedIn())
    const cross = await handler.PATCH(
      req('/api/account/preferences', { method: 'PATCH', headers: { origin: 'https://evil.example' }, body: '{}' }),
      ctx(['preferences']),
    )
    expect(cross.status).toBe(403)

    const tampered = await handler.GET(req('/api/account/me', { headers: { cookie: 'pine.account=eyJ2IjoxfQ.forged' } }), ctx(['me']))
    expect(((await tampered.json()) as { account: Account }).account.wallets).toEqual([])
  })

  it('mints short-lived REST API tokens (identity only) that verify with the shared secret', async () => {
    const handler = createAccountHandler(signedIn())
    const res = await handler.GET(req('/api/account/api-token'), ctx(['api-token']))
    expect(res.status).toBe(200)
    const { token, expiresAt } = (await res.json()) as { token: string; expiresAt: string }
    expect(token).toMatch(/^pine1\./)
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now())
    const claims = await verifyApiToken(token, readServerEnv().authSecret)
    expect(claims).toMatchObject({ sub: 'mara-okafor', aud: 'pine-api', demo: true })
    expect(await verifyApiToken(token, 'another-secret')).toBeNull()
    const old = await mintApiToken({ login: 'x', githubId: 1, demo: false }, 's', Date.now() - 3_600_000)
    expect(await verifyApiToken(old.token, 's')).toBeNull()
    expect((await createAccountHandler(signedOut).GET(req('/api/account/api-token'), ctx(['api-token']))).status).toBe(401)
  })
})
