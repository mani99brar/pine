'use client'

import * as React from 'react'
import { Download, LogOut, ShieldCheck, Star, Trash2, Unlink, Zap } from 'lucide-react'
import { toast } from 'sonner'
import type { AccountPreferences } from '@pine/core'
import { formatDate, shortHash } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { CHAINS, SUPPORTED_CHAIN_IDS } from '@pine/core/chains'
import { useAccount, useAccountData, useDemoWallet, useLinkWallet, useUpdatePreferences, useWallet } from '@pine/react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Field, Input, Segmented, Select, Switch } from '@/components/ui/field'
import { PageHeader } from '@/components/ui/page-header'
import { GitHubMark } from '@/components/ui/pine-mark'
import { Skeleton } from '@/components/ui/skeleton'
import { Avatar } from '@/components/shell/account'
import { useWorkbench } from '@/components/shell/workbench'

const SECTIONS = [
  { id: 'github', label: 'GitHub' },
  { id: 'wallets', label: 'Wallets' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'data', label: 'Your data' },
]

function Block({ id, title, description, children }: { id: string; title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-16 border-b border-line px-4 py-7 sm:px-8">
      <h2 id={`${id}-h`} className="stretch-wide text-[18px] font-[650]">
        {title}
      </h2>
      {description ? <p className="mt-1 max-w-[68ch] text-[13.5px] text-muted">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  )
}

export function Settings() {
  const acc = useAccount()
  const wallet = useWallet()
  const demo = useDemoWallet()
  const link = useLinkWallet()
  const prefs = useUpdatePreferences()
  const data = useAccountData()
  const { theme, setTheme } = useWorkbench()
  const account = acc.account
  const p = account?.preferences

  const save = (patch: Partial<AccountPreferences>) =>
    prefs.mutate(patch, {
      onSuccess: () => toast.success('Preferences saved'),
      onError: (e) => toast.error(`Preferences not saved: ${e.message}`),
    })

  return (
    <div>
      <PageHeader title="Settings" description="Your Pine account is a GitHub identity plus the wallets you prove you control. Nothing here grants Pine any authority over your repositories." />
      <div className="grid grid-cols-1 bg-surface lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="hidden border-r border-line lg:block">
          <ul className="sticky top-12 space-y-px p-3">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="block rounded-ctl px-2.5 py-1.5 text-[13.5px] text-muted hover:bg-sunken hover:text-bark">
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0">
          <Block id="github" title="GitHub" description="Pine asks only for the read:user scope. It reads public repositories, pull requests and commits through a server-side proxy, and your token never reaches the browser.">
            {acc.status === 'loading' ? (
              <Skeleton className="h-16 w-full max-w-[520px]" />
            ) : account ? (
              <div className="flex max-w-[620px] flex-wrap items-center gap-4 rounded-ctl border border-line p-4">
                <Avatar src={account.github.avatarUrl} login={account.github.login} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold">{account.github.name ?? account.github.login}</p>
                  <p className="text-[13px] text-muted">
                    @{account.github.login}
                    {account.demo ? ' (demo identity, no real GitHub connection)' : ''}
                  </p>
                  <p className="mt-1 text-[12px] text-muted">
                    Scopes:{' '}
                    {account.github.scopes.length ? (
                      account.github.scopes.map((s) => (
                        <span key={s} className="mono-cond mr-1 rounded-chip bg-sunken px-1 text-[11px] text-bark">
                          {s}
                        </span>
                      ))
                    ) : (
                      <span className="mono-cond text-[11px]">none</span>
                    )}
                  </p>
                </div>
                <Button variant="secondary" onClick={() => void acc.signOut()}>
                  <LogOut size={14} aria-hidden /> Sign out
                </Button>
              </div>
            ) : (
              <div className="max-w-[620px] space-y-3">
                <div className="flex flex-wrap gap-2">
                  {acc.providers.github ? (
                    <Button variant="primary" size="lg" onClick={() => void acc.signIn('github')}>
                      <GitHubMark size={16} /> Sign in with GitHub
                    </Button>
                  ) : null}
                  {acc.providers.demo ? (
                    <Button variant={acc.providers.github ? 'secondary' : 'primary'} size="lg" onClick={() => void acc.signIn('demo')}>
                      <GitHubMark size={16} /> Use the demo GitHub identity
                    </Button>
                  ) : null}
                </div>
                <ul className="space-y-1 text-[13px] text-muted">
                  <li className="flex gap-2">
                    <ShieldCheck size={14} aria-hidden className="mt-0.5 shrink-0 text-needle" /> Scope read:user only. Public repositories only.
                  </li>
                  <li className="flex gap-2">
                    <ShieldCheck size={14} aria-hidden className="mt-0.5 shrink-0 text-needle" /> No write access: Pine cannot push, merge, comment or deploy.
                  </li>
                  <li className="flex gap-2">
                    <ShieldCheck size={14} aria-hidden className="mt-0.5 shrink-0 text-needle" /> Sessions are signed cookies; delete your account data any time below.
                  </li>
                </ul>
                {!acc.providers.github ? <p className="text-[12.5px] text-muted">GitHub OAuth is not configured on this deployment, so only the demo identity is available.</p> : null}
              </div>
            )}
          </Block>

          <Block id="wallets" title="Wallets" description="Link a wallet by signing a Sign-In with Ethereum message. The signature proves control; it does not approve any spending.">
            {!account ? (
              <p className="text-[13px] text-muted">Sign in first, then link wallets to your account.</p>
            ) : (
              <div className="max-w-[720px] space-y-3">
                {account.wallets.length ? (
                  <ul className="divide-y divide-line rounded-ctl border border-line">
                    {account.wallets.map((w) => (
                      <li key={w.address} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                        <span className="min-w-0 flex-1">
                          <span className="mono-cond block truncate text-[12px]">{w.address}</span>
                          <span className="text-[12px] text-muted">
                            {w.label ?? CHAINS[w.chainId]?.name ?? `chain ${w.chainId}`}, verified {formatDate(w.verifiedAt, 'utc')}
                          </span>
                        </span>
                        {w.primary ? (
                          <span className="flex items-center gap-1 text-[12px] font-medium text-needle">
                            <Star size={12} aria-hidden /> primary
                          </span>
                        ) : (
                          <Button size="xs" variant="ghost" onClick={() => void link.setPrimary(w.address)}>
                            Make primary
                          </Button>
                        )}
                        <Button size="xs" variant="ghost" onClick={() => void link.unlink(w.address).then(() => toast.success(`Unlinked ${shortHash(w.address)}`))}>
                          <Unlink size={12} aria-hidden /> Unlink
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[13px] text-muted">No wallets linked yet.</p>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  {wallet.address && account.wallets.some((w) => w.address.toLowerCase() === wallet.address!.toLowerCase()) ? (
                    <p className="text-[13px] text-muted">The connected wallet is linked. Connect another wallet to link it too.</p>
                  ) : (
                  <Button
                    variant="primary"
                    disabled={link.status === 'signing' || link.status === 'verifying' || link.status === 'connecting'}
                    onClick={() =>
                      void link
                        .link()
                        .then((w) => toast.success(`Linked ${shortHash(w.address)}`))
                        .catch((e: Error) => toast.error(e.message))
                    }
                  >
                    {link.status === 'signing' ? 'Waiting for signature…' : link.status === 'verifying' ? 'Verifying…' : wallet.isConnected ? `Link ${shortHash(wallet.address!)}` : 'Connect and link a wallet'}
                  </Button>
                  )}
                  {link.error ? <span className="text-[12.5px] text-flare">{link.error}</span> : null}
                </div>
                {demo.enabled ? <p className="text-[12px] text-muted">Demo mode links the simulated wallet through a labelled demo route without a real signature.</p> : null}
              </div>
            )}
          </Block>

          <Block id="preferences" title="Preferences" description="Defaults for new verifications. Each publication still asks for explicit wallet approval.">
            {!account || !p ? (
              <p className="text-[13px] text-muted">Sign in to save preferences.</p>
            ) : (
              <div className="grid max-w-[720px] gap-5 sm:grid-cols-2">
                <Field label="Default chain" htmlFor="pref-chain">
                  <Select id="pref-chain" value={String(p.defaultChainId)} onChange={(e) => save({ defaultChainId: Number(e.target.value) })}>
                    {SUPPORTED_CHAIN_IDS.map((id) => (
                      <option key={id} value={id}>
                        {CHAINS[id]?.name ?? id}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={`Default spending limit (${CHAINS[p.defaultChainId]?.collateral.symbol ?? 'collateral'})`} htmlFor="pref-limit" hint={COPY.spendingLimit}>
                  <LimitInput key={p.defaultSpendingLimit} value={p.defaultSpendingLimit} onSave={(v) => save({ defaultSpendingLimit: v })} />
                </Field>
                <Field label="Notification email" htmlFor="pref-email" hint="Optional. Used only for the alerts below.">
                  <EmailInput key={p.notificationEmail ?? ''} value={p.notificationEmail ?? ''} onSave={(v) => save({ notificationEmail: v || undefined })} />
                </Field>
                <Field label="Display amounts in" htmlFor="pref-cur">
                  <Segmented
                    label="Display currency"
                    value={p.displayCurrency}
                    onChange={(v) => save({ displayCurrency: v })}
                    options={[
                      { value: 'collateral', label: 'Collateral' },
                      { value: 'usd', label: 'USD estimate' },
                    ]}
                  />
                </Field>
                <fieldset className="sm:col-span-2">
                  <legend className="stretch-cond mb-2 text-[13px] font-medium">Notify me when</legend>
                  <div className="divide-y divide-line rounded-ctl border border-line">
                    {(
                      [
                        ['notifyOnEvidence', 'Evidence is submitted on my claims'],
                        ['notifyOnAnswer', 'An oracle answer is posted or challenged'],
                        ['notifyOnDeadline', 'An evidence deadline is within 24 hours'],
                      ] as const
                    ).map(([k, label]) => (
                      <div key={k} className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <label htmlFor={`pref-${k}`} className="text-[13.5px]">
                          {label}
                        </label>
                        <Switch id={`pref-${k}`} label={label} checked={p[k]} onChange={(v) => save({ [k]: v })} />
                      </div>
                    ))}
                  </div>
                </fieldset>
              </div>
            )}
          </Block>

          <Block id="appearance" title="Appearance and demo controls">
            <div className="flex max-w-[720px] flex-col gap-4">
              <Field label="Theme" htmlFor="theme" hint="Press t anywhere to cycle.">
                <Segmented
                  label="Theme"
                  value={theme}
                  onChange={setTheme}
                  options={[
                    { value: 'system', label: 'System' },
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                  ]}
                />
              </Field>
              {demo.enabled ? (
                <Callout
                  tone="warning"
                  title="Simulate a wallet failure"
                  action={
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        demo.failNext()
                        toast('The next simulated transaction will fail')
                      }}
                    >
                      <Zap size={13} aria-hidden /> {demo.pendingFailure ? 'Armed' : 'Fail next transaction'}
                    </Button>
                  }
                >
                  The next simulated wallet prompt is rejected, so you can exercise retry and recovery in publishing, evidence and redemption.
                </Callout>
              ) : null}
            </div>
          </Block>

          <Block id="data" title="Your data" description="Export everything Pine stores about your account, or delete it. Published claims, evidence and on-chain history are public and cannot be deleted.">
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={!account} onClick={() => void data.exportData()}>
                <Download size={14} aria-hidden /> Export account data (JSON)
              </Button>
              <Button
                variant="danger"
                disabled={!account}
                onClick={() => {
                  if (!window.confirm('Delete your Pine account data? Linked wallets and preferences are removed. On-chain records stay public.')) return
                  void data.deleteAccount().then(() => {
                    toast.success('Account data deleted')
                    void acc.signOut()
                  })
                }}
              >
                <Trash2 size={14} aria-hidden /> Delete account data
              </Button>
            </div>
          </Block>
        </div>
      </div>
    </div>
  )
}

function LimitInput({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = React.useState(value)
  const valid = /^\d+(\.\d+)?$/.test(v) && Number(v) > 0
  return (
    <Input
      id="pref-limit"
      inputMode="decimal"
      className={cn('tnum')}
      value={v}
      aria-invalid={!valid || undefined}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => valid && v !== value && onSave(v)}
    />
  )
}

function EmailInput({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = React.useState(value)
  return <Input id="pref-email" type="email" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v.trim())} placeholder="you@example.com" />
}
