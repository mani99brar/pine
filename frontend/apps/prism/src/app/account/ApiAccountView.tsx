'use client'

import { useEffect, useRef, useState } from 'react'
import type { BackendIdentity, PineSession, UseAccountResult } from '@pine/react'
import { useAccount, useGitHubLink, usePendingSiweTerms, usePine, useUpdatePreferences, useWallet, useWalletSwitchNotice } from '@pine/react'
import { formatDate } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { Link2, LogOut, ShieldCheck, Wallet } from 'lucide-react'
import { Initials } from '@/components/shell/SiteHeader'
import { Button, ExternalLink } from '@/components/ui/Button'
import { Dialog, HashChip } from '@/components/ui/interactive'
import { FormField, Notice, Panel, Skeleton } from '@/components/ui/primitives'
import { checksummed, shortAddress } from '@/components/shell/wallet-display'
import { useMounted } from '@/lib/hooks'
import { ApiSignIn, SessionCheckFailed } from './ApiSignIn'
import { focusAfter, takeFocus } from './focus'
import { Notifications } from './Notifications'

function WalletPanel({ a, backend, session }: { a: UseAccountResult; backend: BackendIdentity; session: PineSession }) {
  const { env } = usePine()
  const wallet = useWallet()
  const { notice } = useWalletSwitchNotice()
  const heading = useRef<HTMLHeadingElement | null>(null)
  const [everywhere, setEverywhere] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bound = session.wallet.toLowerCase()
  const short = shortAddress(bound)
  const chain = getChainOrDefault(env.defaultChainId)
  const connected = wallet.isConnected && wallet.address ? wallet.address.toLowerCase() : null

  useEffect(() => {
    if (takeFocus('signed-in')) heading.current?.focus()
  }, [])

  const signOut = async () => {
    setError(null)
    setBusy(true)
    try {
      focusAfter('signed-out')
      await a.signOut({ everywhere })
    } catch (e) {
      // The session is cleared in this browser either way; the server may keep it until it expires.
      setError(e instanceof Error ? e.message : 'The server could not confirm the sign-out.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel className="p-6" aria-labelledby="wallet-title">
      <h2 id="wallet-title" ref={heading} tabIndex={-1} className="t-h3 focus:outline-none">
        Your wallet
      </h2>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span className="text-[0.9375rem] text-lumen-2">Signed in as</span>
        <HashChip value={checksummed(bound)} display={short} name="Signed-in wallet" />
        {backend.isAdmin && <span className="tag text-ca">Admin</span>}
      </div>
      <dl className="mt-4 grid gap-x-6 gap-y-2 text-[0.875rem] sm:grid-cols-[max-content_1fr]">
        <dt className="text-lumen-3">Network</dt>
        <dd className="text-lumen">
          {chain.name} (chain id {chain.id})
        </dd>
        <dt className="text-lumen-3">Signed in</dt>
        <dd className="text-lumen">{formatDate(session.authenticatedAt, 'utc')}</dd>
        <dt className="text-lumen-3">Session ends</dt>
        <dd className="text-lumen">{formatDate(session.absoluteExpiresAt, 'utc')} at the latest, earlier after a period without use</dd>
      </dl>

      {backend.walletMismatch ? (
        <Notice tone="caution" role="status" className="mt-5" title="Your wallet switched accounts">
          The connected wallet is {connected ? shortAddress(connected) : 'another account'}, not {short}. A Pine session belongs to the wallet that signed in, so
          Pine is signing you out.
          {notice?.state === 'failed' && (
            <span className="mt-2 block">
              <Button size="sm" variant="glass" onClick={() => void signOut()} loading={busy}>
                Sign out now
              </Button>
            </span>
          )}
        </Notice>
      ) : !connected ? (
        <Notice tone="info" className="mt-5" title="Connect this wallet to sign transactions">
          Pine prepares transactions for {short}; your wallet signs them. Nothing is ever signed for you.
          <span className="mt-2 block">
            <Button size="sm" variant="glass" onClick={() => wallet.connect()} icon={<Wallet size={14} aria-hidden />}>
              Connect wallet
            </Button>
          </span>
        </Notice>
      ) : wallet.chainId !== undefined && wallet.chainId !== chain.id ? (
        <p className="help mt-4">
          Your wallet is on {getChainOrDefault(wallet.chainId).name}. It is asked to switch to {chain.name} when you sign a transaction.
        </p>
      ) : null}

      <div className="mt-6 border-t border-edge pt-5">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <Button variant="glass" onClick={() => void signOut()} loading={busy} icon={<LogOut size={15} aria-hidden />}>
            Sign out
          </Button>
          <label htmlFor="signout-everywhere" className="flex items-center gap-2.5 text-[0.875rem] text-lumen-2">
            <input
              id="signout-everywhere"
              type="checkbox"
              className="facet-check mt-0"
              checked={everywhere}
              onChange={(e) => setEverywhere(e.target.checked)}
              aria-describedby="signout-everywhere-help"
            />
            Sign out everywhere
          </label>
        </div>
        <p id="signout-everywhere-help" className="help mt-2">
          Everywhere ends every session of this wallet, in every browser and on every device.
        </p>
        {error && (
          <p className="mt-2 text-[0.84375rem] font-medium text-ha" role="alert">
            {error}
          </p>
        )}
      </div>
    </Panel>
  )
}

function GitHubPanel({ backend }: { backend: BackendIdentity }) {
  const gh = useGitHubLink()
  const [confirm, setConfirm] = useState(false)
  const github = backend.github

  const unlink = async () => {
    focusAfter('signed-out')
    try {
      await gh.unlink()
    } catch {
      // Shown from the hook's error state.
    }
    setConfirm(false)
  }

  return (
    <Panel className="p-6" aria-labelledby="github-title">
      <h2 id="github-title" className="t-h3">
        GitHub
      </h2>
      {github ? (
        <>
          <div className="mt-4 flex items-center gap-4">
            <Initials name={github.login} size={48} />
            <div className="min-w-0">
              <p className="truncate text-[1.05rem] font-semibold text-lumen">Linked as @{github.login}</p>
              <p className="text-[0.84375rem] text-lumen-3">GitHub user id {github.id}</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <ExternalLink href={`https://github.com/${github.login}`} className="text-[0.875rem] text-lumen-2">
              View on GitHub
            </ExternalLink>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setConfirm(true)}>
              Unlink GitHub
            </Button>
          </div>
          <p className="help mt-2">Unlinking also signs you out.</p>
        </>
      ) : (
        <>
          <p className="mt-3 text-[0.9375rem] text-lumen-2">Link GitHub to browse repositories, preview claims and publish them.</p>
          <Button className="mt-4" onClick={() => void gh.link().catch(() => undefined)} loading={gh.busy} icon={<Link2 size={16} aria-hidden />}>
            Link GitHub
          </Button>
        </>
      )}
      <p className="mt-5 flex items-start gap-2.5 text-[0.875rem] text-lumen-2">
        <ShieldCheck size={17} aria-hidden className="mt-0.5 shrink-0 text-hb" />
        <span>
          Pine&apos;s GitHub App requests no permissions: no repository, organization or account access. GitHub tells Pine only your public user id and
          login. Pine cannot read private repositories, write code or open pull requests. {COPY.noMergeAuthority}
        </span>
      </p>
      {gh.error && (
        <Notice tone="critical" role="alert" className="mt-4" title={github ? 'GitHub could not be unlinked' : 'GitHub could not be linked'}>
          <span className="untrusted">{gh.error}</span>
        </Notice>
      )}
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Unlink GitHub?"
        description="Pine forgets the link and revokes its GitHub authorization, and you are signed out. Sign in again with your wallet; link GitHub again before you publish a claim."
      >
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(false)}>
            Keep it linked
          </Button>
          <Button variant="danger" onClick={() => void unlink()} loading={gh.busy}>
            Unlink GitHub and sign out
          </Button>
        </div>
      </Dialog>
    </Panel>
  )
}

function TermsPanel({ a, backend }: { a: UseAccountResult; backend: BackendIdentity }) {
  const wallet = useWallet()
  const pendingTerms = usePendingSiweTerms()
  const step = backend.siwe.step
  const busy = step === 'challenge' || step === 'signing' || step === 'verifying'
  const digest = backend.termsDigest
  return (
    <Panel className="p-6" aria-labelledby="terms-title">
      <h2 id="terms-title" className="t-h3">
        Terms
      </h2>
      {backend.termsAccepted ? (
        <>
          <p className="mt-3 text-[0.9375rem] text-lumen-2">You accepted Pine&apos;s current terms when you signed in. The signed message is the record.</p>
          {digest && <HashChip value={digest} label="Terms sha256" className="mt-3 max-w-full" />}
        </>
      ) : (
        <Notice tone="caution" className="mt-4" title="Pine's terms changed">
          Sign in again to accept the current terms{digest ? ' below' : ''}. Until you do, Pine prepares no transactions for you. Signing authorizes no
          transaction or spending.
          {digest && (
            <span className="mt-3 block">
              <HashChip value={digest} label="Terms sha256" className="max-w-full" />
            </span>
          )}
          <span className="mt-3 block">
            <Button size="sm" onClick={() => void a.signIn().catch(() => undefined)} loading={busy} disabled={!wallet.isConnected}>
              Sign in again to accept
            </Button>
          </span>
          {!wallet.isConnected && <span className="help mt-2 block">Connect your wallet first.</span>}
          {pendingTerms && <span className="mt-2 block text-[0.84375rem]">Your wallet shows the terms sha256 {pendingTerms}.</span>}
        </Notice>
      )}
      <p className="mt-2 min-h-[1.4em] text-[0.84375rem] text-lumen-2" role="status" aria-live="polite">
        {step === 'signing' ? 'Sign the message in your wallet.' : step === 'verifying' ? 'Checking your signature.' : step === 'challenge' ? 'Asking Pine for a sign-in message.' : ''}
      </p>
      {step === 'error' && backend.siwe.error && (
        <p className="text-[0.84375rem] font-medium text-ha" role="alert">
          <span className="untrusted">{backend.siwe.error}</span>
        </p>
      )}
    </Panel>
  )
}

function DefaultsPanel({ a, session }: { a: UseAccountResult; session: PineSession }) {
  const prefs = useUpdatePreferences()
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const p = a.account?.preferences
  if (!p) return null
  const sym = getChainOrDefault(p.defaultChainId).collateral.symbol
  const save = () => {
    if (draft === null) return
    const v = draft.trim().replace(',', '.')
    if (v === p.defaultSpendingLimit) return setDraft(null)
    if (!/^\d{1,15}(\.\d{1,6})?$/.test(v) || !/[1-9]/.test(v)) return setError('Enter a positive amount, for example 50 or 120.5.')
    setError(null)
    setSaved(null)
    prefs.mutate(
      { defaultSpendingLimit: v },
      {
        onSuccess: () => {
          setDraft(null)
          setSaved(`Default spending limit saved: ${v} ${sym}`)
        },
        onError: (e) => setError(e.message),
      },
    )
  }
  return (
    <Panel className="p-6" aria-labelledby="defaults-title">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="defaults-title" className="t-h3">
          Defaults
        </h2>
        <p className="text-[0.84375rem] text-hb" role="status" aria-live="polite">
          {saved ?? (prefs.isPending ? 'Saving' : '')}
        </p>
      </div>
      <FormField
        id="pref-limit"
        className="mt-4"
        label={`Default spending limit (${sym})`}
        help={`New drafts start with this hard cap; you can change it per claim. Saved in this browser for ${shortAddress(session.wallet)}.`}
        error={error ?? undefined}
      >
        <div className="flex gap-2">
          <input
            id="pref-limit"
            className="field tnum"
            inputMode="decimal"
            value={draft ?? p.defaultSpendingLimit}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'pref-limit-error' : 'pref-limit-help'}
          />
          <Button variant="glass" onClick={save} disabled={draft === null}>
            Save
          </Button>
        </div>
      </FormField>
    </Panel>
  )
}

function SignedIn({ a, backend, session }: { a: UseAccountResult; backend: BackendIdentity; session: PineSession }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <WalletPanel a={a} backend={backend} session={session} />
      <GitHubPanel backend={backend} />
      <TermsPanel a={a} backend={backend} />
      <DefaultsPanel a={a} session={session} />
      <Notifications className="lg:col-span-2" />
      <p className="text-[0.84375rem] text-lumen-3 lg:col-span-2">
        Pine keeps your sign-in, the GitHub link and your notifications. Drafts, transaction progress and these defaults stay in this browser. On-chain
        actions are always signed by your wallet.
      </p>
    </div>
  )
}

/** `api` mode account: the backend's wallet session (Sign-In with Ethereum), the GitHub link, terms and notifications. */
export function ApiAccountView() {
  const mounted = useMounted()
  const a = useAccount()
  const backend = a.backend
  const signedIn = mounted && a.status === 'signed_in' && backend?.session ? backend.session : null
  return (
    <>
      <p className="sr-only" role="status" aria-live="polite">
        {signedIn ? `Signed in as ${shortAddress(signedIn.wallet)}` : ''}
      </p>
      {!mounted || a.status === 'loading' || !backend ? (
        <Skeleton className="h-72 w-full" />
      ) : a.status === 'error' ? (
        // Unknown, not signed out: offering a sign-in here would start a second session.
        <div className="glass cut-xl p-6 sm:p-8">
          <h2 className="t-h2">Your Pine session</h2>
          <SessionCheckFailed error={a.error} refresh={a.refresh} className="mt-6" />
        </div>
      ) : signedIn ? (
        <SignedIn a={a} backend={backend} session={signedIn} />
      ) : (
        <ApiSignIn />
      )}
    </>
  )
}
