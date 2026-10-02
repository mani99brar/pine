/**
 * Account persistence for mock/envio mode: an HMAC-signed, httpOnly cookie (`pine.account`).
 *
 * Why a cookie: it survives server restarts and works on serverless/edge hosts with many instances,
 * with no database. Contents are small (wallet list + preferences) and are bound to the GitHub login
 * of the session; a cookie for another login is ignored. The signature (HMAC-SHA256 keyed from
 * AUTH_SECRET) prevents tampering. In rest mode accounts are stored by the REST API instead.
 */
import type { Account, AccountPreferences, Address, LinkedWallet } from '@pine/core'
import { isHttps, readCookie, serializeCookie } from './http'
import type { PineSessionUser } from './session'

export const ACCOUNT_COOKIE = 'pine.account'
const ONE_YEAR = 365 * 24 * 60 * 60

export interface StoredAccount {
  v: 1
  login: string
  wallets: LinkedWallet[]
  preferences: AccountPreferences
  createdAt: string
}

export function defaultPreferences(defaultChainId = 100): AccountPreferences {
  return {
    defaultChainId,
    defaultSpendingLimit: '50',
    notifyOnEvidence: true,
    notifyOnAnswer: true,
    notifyOnDeadline: true,
    displayCurrency: 'collateral',
  }
}

const enc = new TextEncoder()

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(`pine-cookie:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
}

/** Signs a string payload: `<b64url(payload)>.<b64url(hmac)>`. */
export async function signValue(payload: string, secret: string): Promise<string> {
  const key = await hmacKey(secret)
  const data = enc.encode(payload)
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, data))
  return `${b64url(data)}.${b64url(sig)}`
}

/** Verifies and returns the payload, or null when missing/tampered. */
export async function unsignValue(signed: string | undefined, secret: string): Promise<string | null> {
  if (!signed) return null
  const i = signed.lastIndexOf('.')
  if (i <= 0) return null
  try {
    const data = fromB64url(signed.slice(0, i))
    const sig = fromB64url(signed.slice(i + 1))
    const key = await hmacKey(secret)
    const ok = await crypto.subtle.verify('HMAC', key, sig as BufferSource, data as BufferSource)
    return ok ? new TextDecoder().decode(data) : null
  } catch {
    return null
  }
}

export async function readStoredAccount(req: Request, login: string, secret: string): Promise<StoredAccount | null> {
  const raw = await unsignValue(readCookie(req, ACCOUNT_COOKIE), secret)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as StoredAccount
    if (parsed?.v !== 1 || parsed.login !== login) return null
    return parsed
  } catch {
    return null
  }
}

export async function accountCookie(req: Request, stored: StoredAccount, secret: string): Promise<string> {
  const value = await signValue(JSON.stringify(stored), secret)
  return serializeCookie(ACCOUNT_COOKIE, value, { maxAge: ONE_YEAR, httpOnly: true, secure: isHttps(req), sameSite: 'Lax' })
}

export function clearAccountCookie(req: Request): string {
  return serializeCookie(ACCOUNT_COOKIE, '', { maxAge: 0, httpOnly: true, secure: isHttps(req), sameSite: 'Lax' })
}

export function toAccount(user: PineSessionUser, stored: StoredAccount): Account {
  return {
    id: `gh:${user.login}`,
    github: {
      login: user.login,
      id: user.githubId,
      name: user.name ?? null,
      avatarUrl: user.avatarUrl,
      htmlUrl: user.htmlUrl,
      scopes: user.scopes,
    },
    wallets: stored.wallets,
    preferences: stored.preferences,
    createdAt: stored.createdAt,
    demo: user.demo,
  }
}

export function freshStored(login: string, defaultChainId: number): StoredAccount {
  return {
    v: 1,
    login,
    wallets: [],
    preferences: defaultPreferences(defaultChainId),
    createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
}

export function linkWallet(stored: StoredAccount, wallet: Omit<LinkedWallet, 'primary'> & { primary?: boolean }): StoredAccount {
  const others = stored.wallets.filter((w) => w.address.toLowerCase() !== wallet.address.toLowerCase())
  const existing = stored.wallets.find((w) => w.address.toLowerCase() === wallet.address.toLowerCase())
  const primary = existing?.primary ?? (wallet.primary ?? others.length === 0)
  const next: LinkedWallet = { ...wallet, primary }
  const wallets = primary ? [...others.map((w) => ({ ...w, primary: false })), next] : [...others, next]
  return { ...stored, wallets: wallets.slice(-10) }
}

export function unlinkWallet(stored: StoredAccount, address: Address): StoredAccount {
  const removed = stored.wallets.find((w) => w.address.toLowerCase() === address.toLowerCase())
  const wallets = stored.wallets.filter((w) => w.address.toLowerCase() !== address.toLowerCase())
  if (removed?.primary && wallets[0]) wallets[0] = { ...wallets[0], primary: true }
  return { ...stored, wallets }
}

export function setPrimary(stored: StoredAccount, address: Address): StoredAccount | null {
  if (!stored.wallets.some((w) => w.address.toLowerCase() === address.toLowerCase())) return null
  return {
    ...stored,
    wallets: stored.wallets.map((w) => ({ ...w, primary: w.address.toLowerCase() === address.toLowerCase() })),
  }
}
