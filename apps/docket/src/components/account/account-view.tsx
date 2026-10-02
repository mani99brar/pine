'use client'

import { useState } from 'react'
import type { AccountPreferences } from '@pine/core'
import { formatDate } from '@pine/core'
import { CHAINS, SUPPORTED_CHAIN_IDS } from '@pine/core/chains'
import { SIWE_STATEMENT, useAccount, useAccountData, useLinkWallet, useUpdatePreferences, useWallet } from '@pine/react'
import { Download, LogOut, Star, Trash2, Wallet } from 'lucide-react'
import { GitHubMark } from '@/components/ui/github-mark'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox, Field, Input, MarginNote, Select } from '@/components/ui/field'
import { Confirm } from '@/components/ui/confirm'
import { ExternalLink } from '@/components/ui/external-link'
import { Notice } from '@/components/ui/notice'
import { Skeleton } from '@/components/ui/layout'

const SCOPE_PLAIN: Record<string, string> = {
  'read:user': 'Read your public profile: name, username and avatar.',
  'user:email': 'Read your email addresses.',
  repo: 'Full access to private repositories. Pine never asks for this.',
  public_repo: 'Write access to public repositories. Pine never asks for this.',
}

function diffPrefs(base: AccountPreferences, next: AccountPreferences): Partial<AccountPreferences> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(next) as (keyof AccountPreferences)[]) {
    if (next[k] !== base[k]) out[k] = next[k]
  }
  return out as Partial<AccountPreferences>
}

export function AccountView() {
  const a = useAccount()
  if (a.status === 'loading') {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (a.status !== 'signed_in' || !a.account) return <SignedOut />
  return <SignedIn />
}

function SignedOut() {
  const a = useAccount()
  const [busy, setBusy] = useState(false)
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <section aria-labelledby="create" className="border border-rule bg-sheet p-6 sm:p-8">
        <h2 id="create" className="text-2xl">
          Create your account with GitHub
        </h2>
        <p className="mt-2 text-lg measure">
          Your Pine account is your GitHub identity plus the wallets you link to it. There is no password to remember.
        </p>
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <div>
            <h3 className="font-bold">Pine can</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[15px]">
              <li>Read your public profile: name, username, avatar.</li>
              <li>List your public repositories, pull requests and commits so you can pick one to file about.</li>
            </ul>
          </div>
          <div>
            <h3 className="font-bold">Pine cannot</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[15px]">
              <li>See private repositories.</li>
              <li>Write code, open or merge pull requests, or change settings.</li>
              <li>Act on GitHub on your behalf.</li>
            </ul>
          </div>
        </div>
        <p className="mt-5 text-sm text-graphite">
          Technically, Pine requests the single GitHub scope <code className="font-mono">read:user</code>. You can revoke it at any time in your GitHub
          settings.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button
            size="lg"
            variant="ink"
            icon={<GitHubMark className="size-5" />}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await a.signIn(a.providers.github ? 'github' : 'demo')
              } finally {
                setBusy(false)
              }
            }}
          >
            {a.providers.github ? 'Sign in with GitHub' : 'Sign in with a demo GitHub identity'}
          </Button>
        </div>
        {!a.providers.github ? (
          <p className="mt-3 text-sm text-graphite">
            GitHub sign-in is not configured here, so demo mode signs you in as a sample user. No GitHub account is involved.
          </p>
        ) : null}
      </section>
      <aside className="space-y-6">
        <MarginNote title="Do I need an account?">
          <p>Not to read the docket or file exhibits as an investigator. You need one to browse your repositories and to keep drafts across devices.</p>
        </MarginNote>
        <MarginNote title="And a wallet?">
          <p>Filing funds a market, so you need a wallet to publish. You can link it to your account after signing in.</p>
        </MarginNote>
      </aside>
    </div>
  )
}

function SignedIn() {
  const a = useAccount()
  const account = a.account!
  const gh = account.github
  const link = useLinkWallet()
  const wallet = useWallet()
  const prefsMut = useUpdatePreferences()
  const data = useAccountData()
  // Unsaved edits sit on top of the stored preferences.
  const [edits, setEdits] = useState<Partial<AccountPreferences>>({})
  const prefs: AccountPreferences = { ...account.preferences, ...edits }
  const setPrefs = (next: AccountPreferences) => setEdits(diffPrefs(account.preferences, next))
  const dirty = Object.keys(edits).length > 0

  return (
    <div className="space-y-12">
      <section aria-labelledby="gh" className="border border-rule bg-sheet">
        <div className="flex flex-wrap items-center gap-5 border-b border-rule px-5 py-5 sm:px-7">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={gh.avatarUrl} alt="" width={64} height={64} className="size-16 rounded-xs bg-mist" />
          <div className="min-w-0 flex-1">
            <h2 id="gh" className="text-2xl">
              {gh.name ?? gh.login}
            </h2>
            <p className="text-graphite">
              Signed in with GitHub as <strong className="text-ink">{gh.login}</strong>
              {account.demo ? ' (demo identity)' : ''}. Account created {formatDate(account.createdAt, 'short')}.
            </p>
          </div>
          <Button variant="secondary" icon={<LogOut aria-hidden />} onClick={() => void a.signOut()}>
            Sign out
          </Button>
        </div>
        <div className="px-5 py-5 sm:px-7">
          <h3 className="font-bold">What Pine can do with your GitHub account</h3>
          <ul className="mt-2 space-y-1.5 text-[15px]">
            {(gh.scopes.length ? gh.scopes : ['read:user']).map((s) => (
              <li key={s} className="flex flex-wrap gap-x-3">
                <code className="font-mono text-[14px]">{s}</code>
                <span className="text-graphite">{SCOPE_PLAIN[s] ?? 'Granted by GitHub.'}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-graphite">
            <ExternalLink href="https://github.com/settings/applications">Review or revoke access on GitHub</ExternalLink>
          </p>
        </div>
      </section>

      <section aria-labelledby="wallets">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="wallets" className="text-2xl">
              Linked wallets
            </h2>
            <p className="mt-1 text-graphite measure">
              Linking proves you control an address by signing a message. It does not authorize any transaction or spending.
            </p>
          </div>
          <Button
            icon={<Wallet aria-hidden />}
            disabled={link.status === 'signing' || link.status === 'verifying'}
            onClick={async () => {
              try {
                await link.link()
                toast('Wallet linked')
              } catch {
                /* error shown below */
              }
            }}
          >
            {link.status === 'signing' ? 'Sign the message in your wallet' : link.status === 'verifying' ? 'Checking the signature' : wallet.isConnected ? 'Link the connected wallet' : 'Connect and link a wallet'}
          </Button>
        </div>
        {link.error ? (
          <Notice tone="critical" className="mt-4" title="The wallet was not linked">
            {link.error}
          </Notice>
        ) : null}
        <details className="mt-3">
          <summary className="text-sm font-bold text-violet underline underline-offset-4">The message you will sign</summary>
          <p className="mt-2 border-l-4 border-violet-line bg-sheet px-3 py-2 text-[15px]">{SIWE_STATEMENT}</p>
        </details>
        {account.wallets.length === 0 ? (
          <p className="mt-4 border border-dashed border-rule-strong bg-sheet px-5 py-4 text-graphite">No wallets linked yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-rule border-y border-rule bg-sheet">
            {account.wallets.map((w) => (
              <li key={w.address} className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-[14px] break-all">{w.address}</code>
                    {w.primary ? (
                      <span className="inline-flex items-center gap-1 rounded-xs bg-violet-wash px-1.5 py-0.5 text-xs font-bold text-violet">
                        <Star aria-hidden className="size-3" /> Primary
                      </span>
                    ) : null}
                  </p>
                  <p className="text-sm text-graphite">
                    {w.label ? `${w.label}. ` : ''}Verified {formatDate(w.verifiedAt, 'long')} on {CHAINS[w.chainId]?.name ?? `chain ${w.chainId}`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {!w.primary ? (
                    <Button size="sm" variant="secondary" onClick={() => void link.setPrimary(w.address)}>
                      Make primary
                    </Button>
                  ) : null}
                  <Confirm
                    title="Unlink this wallet?"
                    confirmLabel="Unlink wallet"
                    onConfirm={async () => {
                      await link.unlink(w.address)
                      toast('Wallet unlinked')
                    }}
                    trigger={
                      <Button size="sm" variant="quiet" className="text-red">
                        Unlink
                      </Button>
                    }
                  >
                    The address stays on any market it created or traded in. Unlinking only removes it from your Pine account.
                  </Confirm>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="prefs" className="border border-rule bg-sheet">
        <form
          className="space-y-7 px-5 py-6 sm:px-7"
          onSubmit={(e) => {
            e.preventDefault()
            prefsMut.mutate(prefs, { onSuccess: () => { setEdits({}); toast('Preferences saved') }, onError: (err) => toast('Preferences were not saved', { description: err.message }) })
          }}
        >
          <div>
            <h2 id="prefs" className="text-2xl">
              Preferences
            </h2>
            <p className="mt-1 text-graphite">Defaults for new filings and how you hear about your claims.</p>
          </div>
          <Field id="p-chain" label="Default chain for new filings" guidance={<p>You can still change the chain on each filing.</p>}>
            <Select id="p-chain" className="max-w-xs" value={String(prefs.defaultChainId)} onChange={(e) => setPrefs({ ...prefs, defaultChainId: Number(e.target.value) })}>
              {SUPPORTED_CHAIN_IDS.map((id) => (
                <option key={id} value={id}>
                  {CHAINS[id]?.name ?? id}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            id="p-limit"
            label="Default spending limit"
            hint={`In ${CHAINS[prefs.defaultChainId]?.collateral.symbol ?? 'collateral'}.`}
            guidance={<p>New filings start with this limit. Every step is checked against it before your wallet is asked to sign.</p>}
          >
            <Input id="p-limit" inputMode="decimal" className="w-40" value={prefs.defaultSpendingLimit} onChange={(e) => setPrefs({ ...prefs, defaultSpendingLimit: e.target.value.trim() })} />
          </Field>
          <div role="group" aria-labelledby="notify-legend" className="grid gap-x-10 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
            <div className="space-y-3">
              <p id="notify-legend" className="font-bold">
                Tell me when
              </p>
              <Checkbox label="An exhibit is filed on my claim" checked={prefs.notifyOnEvidence} onChange={(e) => setPrefs({ ...prefs, notifyOnEvidence: e.target.checked })} />
              <Checkbox label="An oracle answer is posted or challenged" checked={prefs.notifyOnAnswer} onChange={(e) => setPrefs({ ...prefs, notifyOnAnswer: e.target.checked })} />
              <Checkbox label="An evidence deadline is a day away" checked={prefs.notifyOnDeadline} onChange={(e) => setPrefs({ ...prefs, notifyOnDeadline: e.target.checked })} />
            </div>
            <aside className="hidden lg:block">
              <MarginNote title="Why the answer alert matters">
                <p>An unchallenged answer becomes final after 3.5 days. If it is wrong, someone has to challenge it in time.</p>
              </MarginNote>
            </aside>
          </div>
          <Field id="p-email" label="Email for notifications" optional guidance={<p>Used only for the alerts above.</p>}>
            <Input id="p-email" type="email" className="max-w-md" value={prefs.notificationEmail ?? ''} onChange={(e) => setPrefs({ ...prefs, notificationEmail: e.target.value || undefined })} />
          </Field>
          <Field id="p-cur" label="Show amounts in">
            <Select id="p-cur" className="max-w-xs" value={prefs.displayCurrency} onChange={(e) => setPrefs({ ...prefs, displayCurrency: e.target.value as AccountPreferences['displayCurrency'] })}>
              <option value="collateral">The market&rsquo;s collateral (sDAI)</option>
              <option value="usd">US dollars, approximate</option>
            </Select>
          </Field>
          <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-5">
            <Button type="submit" disabled={!dirty || prefsMut.isPending}>
              {prefsMut.isPending ? 'Saving' : 'Save preferences'}
            </Button>
            {dirty ? (
              <Button variant="quiet" onClick={() => setEdits({})}>
                Discard changes
              </Button>
            ) : (
              <span className="text-sm text-graphite">All changes saved.</span>
            )}
          </div>
        </form>
      </section>

      <section aria-labelledby="data">
        <h2 id="data" className="text-2xl">
          Your data
        </h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="border border-rule bg-sheet p-5">
            <h3 className="font-bold">Export</h3>
            <p className="mt-1 text-[15px] text-graphite">Download your profile, linked wallets and preferences as JSON.</p>
            <Button className="mt-4" variant="secondary" icon={<Download aria-hidden />} onClick={() => void data.exportData()}>
              Download my data
            </Button>
          </div>
          <div className="border border-red-line bg-sheet p-5">
            <h3 className="font-bold text-red">Delete account</h3>
            <p className="mt-1 text-[15px] text-graphite">
              Removes your profile, linked wallets and preferences from Pine. Markets, exhibits and transactions on-chain are public and stay.
            </p>
            <Confirm
              title="Delete your Pine account?"
              confirmLabel="Delete my account"
              onConfirm={async () => {
                await data.deleteAccount()
                await a.signOut()
                toast('Account deleted')
              }}
              trigger={
                <Button className="mt-4" variant="danger" icon={<Trash2 aria-hidden />}>
                  Delete account
                </Button>
              }
            >
              This removes your profile, linked wallets and preferences. It does not and cannot remove anything already on-chain: markets you created,
              exhibits, trades and liquidity positions remain public and under your wallet&rsquo;s control.
            </Confirm>
          </div>
        </div>
      </section>
    </div>
  )
}
