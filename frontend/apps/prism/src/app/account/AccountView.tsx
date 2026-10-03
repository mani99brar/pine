'use client'

import { useState } from 'react'
import type { AccountPreferences } from '@pine/core'
import { formatDate, shortHash, SUPPORTED_CHAIN_IDS } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { SIWE_STATEMENT, useAccount, useAccountData, useLinkWallet, useUpdatePreferences, useWallet } from '@pine/react'
import { Download, LogOut, Trash2, Wallet } from 'lucide-react'
import { Initials } from '@/components/shell/SiteHeader'
import { Button } from '@/components/ui/Button'
import { Dialog, HashChip } from '@/components/ui/interactive'
import { FormField, Notice, Panel, Skeleton } from '@/components/ui/primitives'
import { useMounted } from '@/lib/hooks'
import { SignIn } from './SignIn'

function Toggle({ id, label, help, checked, onChange }: { id: string; label: string; help?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex items-start justify-between gap-4 py-2">
      <span>
        <span className="block text-[0.9375rem] font-medium text-lumen">{label}</span>
        {help && <span className="help block">{help}</span>}
      </span>
      <input id={id} type="checkbox" role="switch" className="prism-switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

export function AccountView() {
  const mounted = useMounted()
  const a = useAccount()
  const wallet = useWallet()
  const linker = useLinkWallet()
  const prefs = useUpdatePreferences()
  const data = useAccountData()
  const [limitDraft, setLimitDraft] = useState<string | null>(null)
  const [limitError, setLimitError] = useState<string | null>(null)
  const [emailDraft, setEmailDraft] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [exported, setExported] = useState(false)

  if (!mounted || a.status === 'loading') return <Skeleton className="h-72 w-full" />
  if (a.status === 'signed_out' || !a.account) return <SignIn />

  const acc = a.account
  const p = acc.preferences
  const sym = getChainOrDefault(p.defaultChainId).collateral.symbol
  const update = (patch: Partial<AccountPreferences>, what: string) =>
    prefs.mutate(patch, {
      onSuccess: () => {
        setSaved(what)
        window.setTimeout(() => setSaved((cur) => (cur === what ? null : cur)), 2600)
      },
    })
  const saveLimit = () => {
    if (limitDraft === null) return
    const v = limitDraft.trim().replace(',', '.')
    if (v === p.defaultSpendingLimit) return setLimitDraft(null)
    if (!/^\d+(\.\d{1,6})?$/.test(v) || Number(v) <= 0) return setLimitError('Enter a positive amount, for example 50 or 120.5.')
    setLimitError(null)
    setLimitDraft(null)
    update({ defaultSpendingLimit: v }, `Default spending limit saved: ${v} ${sym}`)
  }
  const connectedLinked = wallet.address && acc.wallets.some((w) => w.address.toLowerCase() === wallet.address!.toLowerCase())

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Identity */}
      <Panel className="p-6" aria-labelledby="id-title">
        <h2 id="id-title" className="t-h3">
          GitHub identity
        </h2>
        <div className="mt-4 flex items-center gap-4">
          <Initials name={acc.github.name ?? acc.github.login} size={52} />
          <div className="min-w-0">
            <p className="truncate text-[1.05rem] font-semibold text-lumen">{acc.github.name ?? acc.github.login}</p>
            <p className="text-[0.875rem] text-lumen-3">
              @{acc.github.login}
              {acc.demo && ' (demo identity)'}
            </p>
          </div>
        </div>
        <div className="mt-5">
          <p className="text-[0.875rem] font-semibold text-lumen">Granted scopes</p>
          <p className="mt-1 flex flex-wrap gap-2">
            {acc.github.scopes.length ? acc.github.scopes.map((s) => <code key={s} className="tag t-code">{s}</code>) : <span className="text-[0.875rem] text-lumen-3">None (demo identity)</span>}
          </p>
          <p className="help mt-2">
            <code className="t-code">read:user</code> reads your public profile only. Pine never asks for repository write access and cannot merge or deploy anything. {COPY.noMergeAuthority}
          </p>
        </div>
        <p className="mt-4 text-[0.8125rem] text-lumen-3">Account created {formatDate(acc.createdAt, 'short')}</p>
      </Panel>

      {/* Wallets */}
      <Panel className="p-6" aria-labelledby="wallets-title">
        <h2 id="wallets-title" className="t-h3">
          Linked wallets
        </h2>
        <p className="mt-2 text-[0.9rem] text-lumen-2">Linking signs a Sign-In with Ethereum message. {SIWE_STATEMENT.split('. ').slice(1).join('. ')}</p>
        {acc.wallets.length === 0 ? (
          <p className="mt-4 text-[0.9rem] text-lumen-3">No wallets linked yet.</p>
        ) : (
          <ul className="mt-4 grid gap-2">
            {acc.wallets.map((w) => (
              <li key={w.address} className="cut-md flex flex-wrap items-center gap-3 border border-edge bg-void px-3 py-2.5">
                <HashChip value={w.address} display={shortHash(w.address)} name="Wallet address" />
                <span className="text-[0.8125rem] text-lumen-3">
                  {w.label ?? getChainOrDefault(w.chainId).name}, verified {formatDate(w.verifiedAt, 'short')}
                </span>
                {w.primary ? (
                  <span className="tag text-lumen">Primary</span>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => void linker.setPrimary(w.address)}>
                    Make primary
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void linker.unlink(w.address)} aria-label={`Unlink ${w.address}`}>
                  Unlink
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          {!wallet.isConnected ? (
            <Button variant="glass" onClick={() => wallet.connect()} icon={<Wallet size={15} aria-hidden />}>
              {wallet.isDemo ? 'Connect demo wallet' : 'Connect a wallet'}
            </Button>
          ) : connectedLinked ? (
            <p className="text-[0.875rem] text-lumen-2">The connected wallet is linked.</p>
          ) : (
            <Button onClick={() => void linker.link().catch(() => undefined)} loading={linker.status === 'signing' || linker.status === 'verifying' || linker.status === 'connecting'}>
              Link the connected wallet
            </Button>
          )}
          <span className="text-[0.8125rem] text-lumen-3" role="status" aria-live="polite">
            {linker.status === 'signing' ? 'Sign the message in your wallet' : linker.status === 'verifying' ? 'Verifying the signature' : linker.status === 'linked' ? 'Linked' : ''}
          </span>
        </div>
        {wallet.isDemo && <p className="help mt-2">Demo wallet: linking uses a clearly labelled simulated signature.</p>}
        {linker.error && (
          <Notice tone="critical" role="alert" className="mt-3">
            {linker.error}
          </Notice>
        )}
      </Panel>

      {/* Preferences */}
      <Panel className="p-6 lg:col-span-2" aria-labelledby="preferences-title" id="preferences">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="preferences-title" className="t-h3">
            Defaults and notifications
          </h2>
          <p className="text-[0.84375rem] text-hb" role="status" aria-live="polite">
            {saved ?? (prefs.isPending ? 'Saving' : '')}
          </p>
        </div>
        <div className="mt-5 grid gap-8 md:grid-cols-2">
          <div className="grid content-start gap-5">
            <FormField id="pref-chain" label="Default chain" help="New claims start on this chain.">
              <select id="pref-chain" className="field" value={p.defaultChainId} onChange={(e) => update({ defaultChainId: Number(e.target.value) }, 'Default chain saved')}>
                {SUPPORTED_CHAIN_IDS.map((id) => (
                  <option key={id} value={id}>
                    {getChainOrDefault(id).name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField id="pref-limit" label={`Default spending limit (${sym})`} help="New drafts start with this hard cap. You can change it per claim." error={limitError ?? undefined}>
              <div className="flex gap-2">
                <input
                  id="pref-limit"
                  className="field tnum"
                  inputMode="decimal"
                  value={limitDraft ?? p.defaultSpendingLimit}
                  onChange={(e) => setLimitDraft(e.target.value)}
                  onBlur={saveLimit}
                  onKeyDown={(e) => e.key === 'Enter' && saveLimit()}
                  aria-invalid={Boolean(limitError)}
                />
                <Button variant="glass" onClick={saveLimit} disabled={limitDraft === null}>
                  Save
                </Button>
              </div>
            </FormField>
            <FormField id="pref-currency" label="Show amounts in">
              <select id="pref-currency" className="field" value={p.displayCurrency} onChange={(e) => update({ displayCurrency: e.target.value as AccountPreferences['displayCurrency'] }, 'Display currency saved')}>
                <option value="collateral">Collateral ({sym})</option>
                <option value="usd">US dollars (estimate)</option>
              </select>
            </FormField>
          </div>
          <div className="grid content-start gap-1">
            <Toggle id="n-evidence" label="Evidence filed on my claims" checked={p.notifyOnEvidence} onChange={(v) => update({ notifyOnEvidence: v }, 'Notifications saved')} />
            <Toggle id="n-answer" label="Oracle answers on my claims and positions" checked={p.notifyOnAnswer} onChange={(v) => update({ notifyOnAnswer: v }, 'Notifications saved')} />
            <Toggle id="n-deadline" label="Evidence deadlines within 24 hours" checked={p.notifyOnDeadline} onChange={(v) => update({ notifyOnDeadline: v }, 'Notifications saved')} />
            <FormField id="pref-email" label="Notification email" optional help="Leave empty to see alerts only on your dashboard." className="mt-3">
              <input
                id="pref-email"
                type="email"
                className="field"
                value={emailDraft ?? p.notificationEmail ?? ''}
                onChange={(e) => setEmailDraft(e.target.value)}
                onBlur={() => {
                  if (emailDraft === null) return
                  update({ notificationEmail: emailDraft.trim() || undefined }, 'Email saved')
                  setEmailDraft(null)
                }}
              />
            </FormField>
          </div>
        </div>
      </Panel>

      {/* Data */}
      <Panel className="p-6 lg:col-span-2" aria-labelledby="data-title">
        <h2 id="data-title" className="t-h3">
          Your data
        </h2>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button
            variant="glass"
            onClick={() => {
              void data.exportData()
              setExported(true)
            }}
            icon={<Download size={15} aria-hidden />}
          >
            Export as JSON
          </Button>
          <Button variant="glass" onClick={() => void a.signOut()} icon={<LogOut size={15} aria-hidden />}>
            Sign out
          </Button>
          <Button variant="danger" onClick={() => setConfirmDelete(true)} icon={<Trash2 size={15} aria-hidden />}>
            Delete account
          </Button>
        </div>
        <p className="mt-3 min-h-[1.3em] text-[0.84375rem] text-lumen-2" role="status" aria-live="polite">
          {exported ? 'Your export downloads as JSON with your profile, linked wallets and preferences. Drafts and transaction progress stay in this browser.' : ''}
        </p>
        <p className="text-[0.84375rem] text-lumen-3">{acc.demo ? COPY.demoMode : 'Account data is stored by this deployment. On-chain actions are always signed by your wallet.'}</p>
        <Dialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title="Delete your account?"
          description="This removes your linked wallets and preferences. Published claims, markets and on-chain history cannot be deleted: they are public and immutable."
        >
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                await data.deleteAccount()
                setConfirmDelete(false)
                await a.signOut()
              }}
            >
              Delete my account
            </Button>
          </div>
        </Dialog>
      </Panel>
    </div>
  )
}
