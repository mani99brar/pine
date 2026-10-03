'use client'

import { useState, useSyncExternalStore } from 'react'
import type { AccountPreferences } from '@pine/core'
import { formatDate, shortHash } from '@pine/core'
import { SUPPORTED_CHAIN_IDS, getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { useAccount, useAccountData, useLinkWallet, useUpdatePreferences, useWallet } from '@pine/react'
import { Download, KeyRound, Link2, LogOut, Moon, ShieldCheck, Star, Sun, Trash2, Unlink, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { GitHubMark } from '@/components/ui/GitHubMark'
import { Field, Input, Select } from '@/components/ui/form'
import { Segmented, Switch } from '@/components/ui/interactive'
import { Note, SectionHeading, Skeleton } from '@/components/ui/primitives'
import { ErrorState } from '@/components/ui/states'

type Theme = 'system' | 'light' | 'dark'
const THEME_KEY = 'pine-field:theme'
const themeListeners = new Set<() => void>()

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY)
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}

function setTheme(t: Theme) {
  try {
    if (t === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, t)
  } catch {
    /* storage unavailable: applies to this page view only */
  }
  if (t === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
  themeListeners.forEach((l) => l())
}

function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      themeListeners.add(cb)
      return () => themeListeners.delete(cb)
    },
    readTheme,
    () => 'system',
  )
}

function Panel({ title, description, children, id }: { title: string; description?: React.ReactNode; children: React.ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="grid gap-5 border-t border-line-strong py-8 md:grid-cols-[17rem_minmax(0,1fr)] md:gap-10">
      <div>
        <h2 id={id} className="t-h3">
          {title}
        </h2>
        {description && <p className="mt-1.5 text-[0.88rem] text-ink-2">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

function SignIn() {
  const a = useAccount()
  const [busy, setBusy] = useState<'github' | 'demo' | null>(null)
  const go = async (p: 'github' | 'demo') => {
    setBusy(p)
    try {
      await a.signIn(p)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="mx-auto max-w-[1320px] px-4 pb-10 pt-10 sm:px-6">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <h1 className="t-display-l">Create your account</h1>
          <p className="mt-4 max-w-[52ch] text-[1.05rem] text-ink-2">
            Your account is your GitHub identity plus the wallets you prove you control. You need it to put claims on the board; browsing and investigating need no account.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            {a.providers.github && (
              <Button size="lg" onClick={() => void go('github')} loading={busy === 'github'} icon={<GitHubMark size={18} />}>
                Sign in with GitHub
              </Button>
            )}
            {a.providers.demo && (
              <Button size="lg" variant={a.providers.github ? 'secondary' : 'primary'} onClick={() => void go('demo')} loading={busy === 'demo'}>
                {a.providers.github ? 'Use the demo identity' : 'Sign in with the demo identity'}
              </Button>
            )}
          </div>
          {!a.providers.github && (
            <p className="mt-3 max-w-[52ch] text-[0.84rem] text-ink-3">GitHub OAuth is not configured on this deployment, so sign-in uses a demo identity with sample repositories.</p>
          )}
          {a.error && <ErrorState className="mt-6" title="Sign-in did not complete" error={a.error} />}
        </div>
        <div className="grid content-start gap-3">
          <div className="rounded-[var(--radius-tile)] border-[1.5px] border-ink bg-sheet p-5">
            <p className="flex items-center gap-2 font-[650]">
              <KeyRound size={16} aria-hidden /> What Pine asks GitHub for
            </p>
            <p className="mt-2 text-[0.92rem] text-ink-2">
              The <code className="t-code rounded-[3px] bg-fog-2 px-1">read:user</code> scope only: your public profile. Repositories, pull requests and commits are read from public
              data. Pine cannot see private code, push, merge, or change anything on GitHub.
            </p>
          </div>
          <div className="rounded-[var(--radius-tile)] border border-line bg-sheet p-5">
            <p className="flex items-center gap-2 font-[650]">
              <ShieldCheck size={16} aria-hidden /> Where your token lives
            </p>
            <p className="mt-2 text-[0.92rem] text-ink-2">The GitHub token stays on the server in an encrypted session. It never reaches your browser, the agent API or any claim.</p>
          </div>
          <div className="rounded-[var(--radius-tile)] border border-line bg-sheet p-5">
            <p className="flex items-center gap-2 font-[650]">
              <Wallet size={16} aria-hidden /> Wallets, after you sign in
            </p>
            <p className="mt-2 text-[0.92rem] text-ink-2">
              Link wallets by signing a Sign-In with Ethereum message. Signing costs no gas and approves nothing. {COPY.noMergeAuthority}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

export function AccountView() {
  const a = useAccount()
  const wallet = useWallet()
  const linker = useLinkWallet()
  const prefs = useUpdatePreferences()
  const data = useAccountData()
  const theme = useTheme()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const [limitError, setLimitError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [exported, setExported] = useState(false)

  if (a.status === 'loading') {
    return (
      <div className="mx-auto max-w-[1320px] px-4 py-10 sm:px-6" aria-busy>
        <Skeleton className="h-10 w-72" />
        <Skeleton className="mt-8 h-40" />
      </div>
    )
  }
  if (a.status === 'signed_out' || !a.account) return <SignIn />

  const acc = a.account
  const p = acc.preferences
  const update = (patch: Partial<AccountPreferences>, what?: string) =>
    prefs.mutate(patch, {
      onSuccess: () => {
        setSaved(what ?? 'Saved')
        window.setTimeout(() => setSaved((cur) => (cur === (what ?? 'Saved') ? null : cur)), 2400)
      },
    })
  const saveLimit = (raw: string) => {
    const v = raw.trim().replace(',', '.')
    if (v === p.defaultSpendingLimit) return setLimitError(null)
    if (!/^\d+(\.\d{1,6})?$/.test(v) || Number(v) <= 0) {
      setLimitError('Enter a positive amount, for example 50 or 120.5.')
      return
    }
    setLimitError(null)
    update({ defaultSpendingLimit: v }, `Default spending limit saved: ${v} ${getChainOrDefault(p.defaultChainId).collateral.symbol}`)
  }
  const connectedLinked = wallet.address && acc.wallets.some((w) => w.address.toLowerCase() === wallet.address!.toLowerCase())

  return (
    <div className="mx-auto max-w-[1320px] px-4 pb-10 pt-8 sm:px-6 sm:pt-10">
      <SectionHeading as="h1" title="Account and settings" description={acc.demo ? 'You are signed in with the demo identity. Everything here works, but it is stored for this demo only.' : undefined} />

      <div className="mt-8">
        <Panel id="gh" title="GitHub" description="Your identity on Pine.">
          <div className="flex flex-wrap items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={acc.github.avatarUrl} alt="" width={56} height={56} className="h-14 w-14 rounded-full border-2 border-ink bg-fog-2" />
            <div className="min-w-0">
              <p className="text-[1.1rem] font-[650]">{acc.github.name ?? acc.github.login}</p>
              <p className="text-[0.88rem] text-ink-2">
                @{acc.github.login}
                {acc.demo ? ', demo identity' : ''}, joined {formatDate(acc.createdAt, 'short')}
              </p>
            </div>
          </div>
          <p className="mt-4 text-[0.88rem] text-ink-2">
            Granted scopes:{' '}
            {acc.github.scopes.length ? (
              acc.github.scopes.map((s) => (
                <code key={s} className="t-code mr-1.5 rounded-[3px] bg-fog-2 px-1.5 py-0.5">
                  {s}
                </code>
              ))
            ) : (
              <span>none beyond your public profile</span>
            )}
            . Pine reads public repositories only and can never push or merge.
          </p>
        </Panel>

        <Panel id="wallets" title="Wallets" description="Prove ownership with a Sign-In with Ethereum signature. It costs no gas and approves nothing.">
          {acc.wallets.length === 0 ? (
            <p className="text-[0.92rem] text-ink-2">No wallets linked yet.</p>
          ) : (
            <ul className="divide-y divide-line rounded-[var(--radius-tile)] border border-line bg-sheet">
              {acc.wallets.map((w) => (
                <li key={w.address} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <code className="t-code text-[0.85rem]" title={w.address}>
                    {shortHash(w.address, 6)}
                  </code>
                  {w.primary && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-ink px-2 py-0.5 text-[0.72rem] font-[650] text-on-ink">
                      <Star size={11} aria-hidden /> primary
                    </span>
                  )}
                  {w.label && <span className="text-[0.84rem] text-ink-2">{w.label}</span>}
                  <span className="text-[0.78rem] text-ink-3">
                    {getChainOrDefault(w.chainId).name}, verified {formatDate(w.verifiedAt, 'short')}
                  </span>
                  <span className="ml-auto flex gap-1">
                    {!w.primary && (
                      <Button size="sm" variant="ghost" onClick={() => void linker.setPrimary(w.address)}>
                        Make primary
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => void linker.unlink(w.address)} icon={<Unlink size={14} aria-hidden />}>
                      Unlink
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              onClick={() => void linker.link().catch(() => undefined)}
              loading={linker.status === 'signing' || linker.status === 'verifying' || linker.status === 'connecting'}
              disabled={!!connectedLinked}
              icon={<Link2 size={15} aria-hidden />}
            >
              {connectedLinked ? 'Connected wallet is linked' : wallet.isConnected ? 'Link the connected wallet' : 'Connect and link a wallet'}
            </Button>
            <span className="text-[0.84rem] text-ink-3">
              {linker.status === 'signing' ? 'Sign the message in your wallet…' : linker.status === 'verifying' ? 'Verifying the signature…' : linker.status === 'linked' ? 'Linked.' : ''}
            </span>
          </div>
          {linker.error && <p className="mt-2 text-[0.84rem] font-[550] text-flare-ink">{linker.error}</p>}
          {wallet.isDemo && <p className="mt-2 text-[0.8rem] text-ink-3">Demo mode: the simulated wallet links with a simulated signature.</p>}
        </Panel>

        <Panel id="prefs" title="Defaults" description="Used to start new claims. You can change them per claim.">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Default chain" htmlFor="pref-chain">
              <Select id="pref-chain" value={String(p.defaultChainId)} onChange={(e) => update({ defaultChainId: Number(e.target.value) })}>
                {SUPPORTED_CHAIN_IDS.map((id) => (
                  <option key={id} value={id}>
                    {getChainOrDefault(id).name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Default spending limit" htmlFor="pref-limit" help={`${COPY.spendingLimit} New claims start with this limit; saved when you leave the field or press Enter.`} error={limitError ?? undefined}>
              <div className="flex items-center gap-2">
                <Input
                  id="pref-limit"
                  inputMode="decimal"
                  defaultValue={p.defaultSpendingLimit}
                  aria-invalid={!!limitError}
                  onBlur={(e) => saveLimit(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveLimit(e.currentTarget.value)
                  }}
                  className="t-figure text-right text-[1.1rem]"
                />
                <span className="font-[650]">{getChainOrDefault(p.defaultChainId).collateral.symbol}</span>
              </div>
            </Field>
            <Field label="Show amounts in" htmlFor="pref-currency">
              <Select id="pref-currency" value={p.displayCurrency} onChange={(e) => update({ displayCurrency: e.target.value as AccountPreferences['displayCurrency'] })}>
                <option value="collateral">Collateral (sDAI)</option>
                <option value="usd">US dollars (approximate)</option>
              </Select>
            </Field>
            <div>
              <p className="mb-1.5 text-[0.88rem] font-[620]">Theme</p>
              <Segmented<Theme>
                label="Theme"
                value={theme}
                onChange={setTheme}
                options={[
                  { value: 'system', label: 'System' },
                  { value: 'light', label: <><Sun size={14} aria-hidden />Light</> },
                  { value: 'dark', label: <><Moon size={14} aria-hidden />Night</> },
                ]}
              />
            </div>
          </div>
          <p className="mt-3 min-h-[1.3em] text-[0.84rem] font-[600]" role="status" aria-live="polite">
            {prefs.isError ? <span className="text-flare-ink">Could not save: {prefs.error?.message}</span> : saved ? <span className="text-ink-2">✓ {saved}</span> : null}
          </p>
        </Panel>

        <Panel id="notify" title="Notifications" description="About claims you published. Delivery needs an email address and a configured backend.">
          <div className="grid gap-4">
            <Switch id="n-ev" checked={p.notifyOnEvidence} onChange={(v) => update({ notifyOnEvidence: v })} label="New evidence" description="Someone submits evidence against your claim." />
            <Switch id="n-ans" checked={p.notifyOnAnswer} onChange={(v) => update({ notifyOnAnswer: v })} label="Oracle answers and challenges" description="An answer is posted, challenged or escalated to arbitration." />
            <Switch id="n-dl" checked={p.notifyOnDeadline} onChange={(v) => update({ notifyOnDeadline: v })} label="Deadlines" description="24 hours before an evidence deadline and when an answer is about to finalize." />
            <Field label="Email" htmlFor="n-email" optional>
              <div className="flex gap-2">
                <Input id="n-email" type="email" value={email ?? p.notificationEmail ?? ''} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                <Button variant="secondary" onClick={() => email !== null && update({ notificationEmail: email || undefined }, 'Notification email saved')} disabled={email === null}>
                  Save
                </Button>
              </div>
            </Field>
          </div>
        </Panel>

        <Panel id="data" title="Your data" description="Export everything Pine stores about your account, or delete it.">
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              onClick={() => {
                setExported(true)
                void data.exportData()
              }}
              icon={<Download size={15} aria-hidden />}
            >
              Export as JSON
            </Button>
            <Button variant="secondary" onClick={() => void a.signOut()} icon={<LogOut size={15} aria-hidden />}>
              Sign out
            </Button>
          </div>
          <p className="mt-2 min-h-[1.3em] text-[0.84rem] text-ink-2" role="status" aria-live="polite">
            {exported ? 'Your export is downloading as a JSON file with your profile, linked wallets and preferences. Drafts and transaction progress stay in this browser.' : ''}
          </p>
          <div className="mt-4 rounded-[var(--radius-tile)] border border-dashed border-flare-ink p-4">
            <p className="font-[650]">Delete account</p>
            <p className="mt-1 text-[0.88rem] text-ink-2">
              Removes your linked wallets, preferences and drafts stored with the account. Published claims, markets and on-chain history cannot be deleted; they are public and immutable.
            </p>
            {confirmDelete ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  onClick={async () => {
                    await data.deleteAccount()
                    await a.signOut()
                  }}
                  icon={<Trash2 size={15} aria-hidden />}
                >
                  Delete my account
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Keep it
                </Button>
              </div>
            ) : (
              <Button className="mt-3" variant="danger" onClick={() => setConfirmDelete(true)}>
                Delete account
              </Button>
            )}
          </div>
          <Note className="mt-6">{COPY.demoMode.startsWith('Demo') && acc.demo ? COPY.demoMode : 'Account data is stored by this deployment. On-chain actions are always signed by your wallet.'}</Note>
        </Panel>
      </div>
    </div>
  )
}
