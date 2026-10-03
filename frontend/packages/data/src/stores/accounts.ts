import type { Account, AccountPreferences, Address, GitHubUser, LinkedWallet } from '@pine/core'
import { readPineEnv } from '../env'
import { clone, hasLocalStorage, readStorage, removeStorage, writeStorage } from '../internal/util'
import { fixtures } from '../mock/fixtures'
import { RestClient, type TokenGetter } from '../rest/http'
import { accountFromWire, preferencesPatchToWire, walletToWire, type WireAccount } from '../rest/wire'
import { PineDataError, type AccountStore, type PineEnv } from '../types'

export const ACCOUNT_KEY_PREFIX = 'pine:accounts:'

const memoryAccounts = new Map<string, Account>()

export function defaultPreferences(env?: Pick<PineEnv, 'defaultChainId'>): AccountPreferences {
  return {
    defaultChainId: env?.defaultChainId ?? 100,
    defaultSpendingLimit: '100',
    notifyOnEvidence: true,
    notifyOnAnswer: true,
    notifyOnDeadline: true,
    displayCurrency: 'collateral',
  }
}

const key = (login: string) => login.toLowerCase()

/**
 * Accounts in localStorage (`pine:accounts:<login>`) with an in-memory fallback (server, private mode).
 * In mock mode, fixture accounts (the demo user with two linked wallets) are used as defaults.
 */
export class LocalAccountStore implements AccountStore {
  private readonly useStorage: boolean
  private readonly seed: Map<string, Account>

  constructor(
    private readonly opts: { seed?: Account[]; storage?: boolean; env?: Pick<PineEnv, 'defaultChainId'> } = {},
  ) {
    this.useStorage = (opts.storage ?? true) && hasLocalStorage()
    this.seed = new Map((opts.seed ?? []).map((a) => [key(a.github.login), a]))
  }

  private read(login: string): Account | null {
    const k = key(login)
    const stored = this.useStorage ? readStorage<Account>(ACCOUNT_KEY_PREFIX + k) : memoryAccounts.get(k)
    if (stored) return stored
    if (this.useStorage && readStorage<boolean>(`${ACCOUNT_KEY_PREFIX}${k}:deleted`)) return null
    if (!this.useStorage && memoryAccounts.has(`${k}:deleted`)) return null
    const s = this.seed.get(k)
    return s ? clone(s) : null
  }

  private write(a: Account): Account {
    const k = key(a.github.login)
    if (this.useStorage) {
      writeStorage(ACCOUNT_KEY_PREFIX + k, a)
      removeStorage(`${ACCOUNT_KEY_PREFIX}${k}:deleted`)
    } else {
      memoryAccounts.set(k, clone(a))
      memoryAccounts.delete(`${k}:deleted`)
    }
    return clone(a)
  }

  private require(login: string): Account {
    const a = this.read(login)
    if (!a) throw new PineDataError(`No account for ${login}`, 'not_found')
    return a
  }

  async get(githubLogin: string): Promise<Account | null> {
    const a = this.read(githubLogin)
    return a ? clone(a) : null
  }

  async upsertFromGitHub(user: GitHubUser, scopes: string[], demo: boolean): Promise<Account> {
    const existing = this.read(user.login)
    if (existing) {
      return this.write({ ...existing, github: { ...existing.github, ...user, scopes }, demo })
    }
    return this.write({
      id: `acct_${user.login.toLowerCase()}`,
      github: { ...user, scopes },
      wallets: [],
      preferences: defaultPreferences(this.opts.env),
      createdAt: new Date().toISOString(),
      demo,
    })
  }

  async linkWallet(githubLogin: string, wallet: LinkedWallet): Promise<Account> {
    const a = this.require(githubLogin)
    const others = a.wallets.filter((w) => w.address.toLowerCase() !== wallet.address.toLowerCase())
    const primary = wallet.primary || others.length === 0
    const wallets = [...others.map((w) => (primary ? { ...w, primary: false } : w)), { ...wallet, primary }]
    return this.write({ ...a, wallets })
  }

  async unlinkWallet(githubLogin: string, address: Address): Promise<Account> {
    const a = this.require(githubLogin)
    const removed = a.wallets.find((w) => w.address.toLowerCase() === address.toLowerCase())
    let wallets = a.wallets.filter((w) => w.address.toLowerCase() !== address.toLowerCase())
    if (removed?.primary && wallets.length > 0 && !wallets.some((w) => w.primary)) {
      wallets = wallets.map((w, i) => (i === 0 ? { ...w, primary: true } : w))
    }
    return this.write({ ...a, wallets })
  }

  async setPrimaryWallet(githubLogin: string, address: Address): Promise<Account> {
    const a = this.require(githubLogin)
    if (!a.wallets.some((w) => w.address.toLowerCase() === address.toLowerCase())) {
      throw new PineDataError(`${address} is not linked to ${githubLogin}`, 'not_found')
    }
    return this.write({ ...a, wallets: a.wallets.map((w) => ({ ...w, primary: w.address.toLowerCase() === address.toLowerCase() })) })
  }

  async updatePreferences(githubLogin: string, prefs: Partial<AccountPreferences>): Promise<Account> {
    const a = this.require(githubLogin)
    return this.write({ ...a, preferences: { ...a.preferences, ...prefs } })
  }

  async exportData(githubLogin: string): Promise<Record<string, unknown>> {
    const a = this.require(githubLogin)
    return { exportedAt: new Date().toISOString(), format: 'pine-account-export/v1', account: clone(a) }
  }

  async remove(githubLogin: string): Promise<void> {
    const k = key(githubLogin)
    if (this.useStorage) {
      removeStorage(ACCOUNT_KEY_PREFIX + k)
      writeStorage(`${ACCOUNT_KEY_PREFIX}${k}:deleted`, true)
    } else {
      memoryAccounts.delete(k)
      memoryAccounts.set(`${k}:deleted`, {} as Account)
    }
  }
}

/** Accounts via the REST write API (bearer auth): /accounts/{login}, wallets, preferences, export, delete. */
export class RestAccountStore implements AccountStore {
  private readonly client: RestClient
  constructor(opts: { baseUrl: string; getToken?: TokenGetter; fetch?: typeof fetch }) {
    this.client = new RestClient(opts)
  }

  private path(login: string, suffix = ''): string {
    return `/accounts/${encodeURIComponent(login)}${suffix}`
  }

  private async must(r: Promise<WireAccount | null>): Promise<Account> {
    const w = await r
    if (!w) throw new PineDataError('Empty account response', 'bad_response')
    return accountFromWire(w)
  }

  async get(githubLogin: string): Promise<Account | null> {
    const w = await this.client.request<WireAccount>('GET', this.path(githubLogin), { auth: true, nullOn404: true })
    return w ? accountFromWire(w) : null
  }

  upsertFromGitHub(user: GitHubUser, scopes: string[], demo: boolean): Promise<Account> {
    return this.must(
      this.client.request<WireAccount>('PUT', this.path(user.login), {
        auth: true,
        body: { github: { login: user.login, id: user.id, name: user.name ?? null, avatar_url: user.avatarUrl, html_url: user.htmlUrl, scopes }, demo },
      }),
    )
  }

  linkWallet(githubLogin: string, wallet: LinkedWallet): Promise<Account> {
    return this.must(this.client.request<WireAccount>('POST', this.path(githubLogin, '/wallets'), { auth: true, body: walletToWire(wallet) }))
  }

  unlinkWallet(githubLogin: string, address: Address): Promise<Account> {
    return this.must(this.client.request<WireAccount>('DELETE', this.path(githubLogin, `/wallets/${encodeURIComponent(address)}`), { auth: true }))
  }

  setPrimaryWallet(githubLogin: string, address: Address): Promise<Account> {
    return this.must(this.client.request<WireAccount>('POST', this.path(githubLogin, `/wallets/${encodeURIComponent(address)}/primary`), { auth: true }))
  }

  updatePreferences(githubLogin: string, prefs: Partial<AccountPreferences>): Promise<Account> {
    return this.must(this.client.request<WireAccount>('PATCH', this.path(githubLogin, '/preferences'), { auth: true, body: preferencesPatchToWire(prefs) }))
  }

  async exportData(githubLogin: string): Promise<Record<string, unknown>> {
    const r = await this.client.request<Record<string, unknown>>('GET', this.path(githubLogin, '/export'), { auth: true })
    return r ?? {}
  }

  async remove(githubLogin: string): Promise<void> {
    await this.client.request('DELETE', this.path(githubLogin), { auth: true, nullOn404: true })
  }
}

/** `rest` with an API URL → RestAccountStore; otherwise local (mock mode seeds the demo accounts). */
export function createAccountStore(env: PineEnv = readPineEnv(), opts: { getToken?: TokenGetter; fetch?: typeof fetch } = {}): AccountStore {
  if (env.dataSource === 'rest' && env.apiUrl) return new RestAccountStore({ baseUrl: env.apiUrl, getToken: opts.getToken, fetch: opts.fetch })
  return new LocalAccountStore({ seed: env.dataSource === 'mock' ? fixtures.accounts : undefined, env })
}
