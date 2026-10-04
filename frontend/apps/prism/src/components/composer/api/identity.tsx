'use client'

import type { ReactNode } from 'react'
import type { Address } from '@pine/core'
import type { SiweStep } from '@pine/react'
import { useAccount, useGitHubLink, useWallet } from '@pine/react'
import { Link2, LogIn, RotateCw, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { LoadingBlock, Notice } from '@/components/ui/primitives'
import { shortAddress } from '@/components/shell/wallet-display'
import { cn } from '@/lib/cn'

// Who is composing, in api mode: the wallet signed in to Pine (SIWE), its linked GitHub account and the wallet connected
// right now. GitHub browsing and previews need the session and the GitHub link; publishing also needs the current terms
// and the session wallet connected (the claim document names it as the creator).

const SIWE_TEXT: Partial<Record<SiweStep, string>> = {
  connecting: 'Connect a wallet to continue.',
  challenge: 'Asking Pine for a sign-in message.',
  signing: 'Sign the message in your wallet.',
  verifying: 'Checking your signature.',
  done: 'Signed in.',
}

export interface ApiIdentity {
  /** `error`: Pine could not be asked whether there is a session; it is unknown, neither signed in nor out. */
  status: 'loading' | 'signed_out' | 'signed_in' | 'error'
  /** The session wallet (lowercase). */
  wallet: Address | null
  github: { login: string; id: number } | null
  termsAccepted: boolean
  /** The wallet connected right now. */
  connected: Address | null
  /** The connected wallet is the session wallet. */
  sameWallet: boolean
}

export function useApiIdentity(): ApiIdentity {
  const a = useAccount()
  const w = useWallet()
  const b = a.backend
  const connected = w.isConnected && w.address ? (w.address.toLowerCase() as Address) : null
  return {
    status: a.status,
    wallet: b?.wallet ?? null,
    github: b?.github ?? null,
    termsAccepted: b?.termsAccepted ?? false,
    connected,
    sameWallet: Boolean(connected && b?.wallet && connected === b.wallet),
  }
}

/** What an action needs: a session (and GitHub for reading repositories), plus the current terms and wallet to publish. */
export type IdentityNeed = 'github' | 'preview' | 'publish'

/** True when the identity satisfies `need`. */
export function identityReady(id: ApiIdentity, need: IdentityNeed): boolean {
  if (id.status !== 'signed_in' || !id.github) return false
  if (need === 'github') return true
  if (!id.sameWallet) return false
  return need === 'preview' || id.termsAccepted
}

function GatePanel({ title, icon, children, className }: { title: string; icon: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('glass cut-lg p-5 sm:p-6', className)} aria-label={title}>
      <h3 className="t-h4 flex items-center gap-2">
        <span className="text-hb">{icon}</span>
        {title}
      </h3>
      <div className="mt-2 max-w-[62ch] text-[0.9375rem] leading-[1.55] text-lumen-2">{children}</div>
    </section>
  )
}

/**
 * Sign-in replaces the per-user query cache (the draft being composed among it) and linking GitHub leaves the page, so
 * pending draft edits are saved first.
 */
export function useIdentityActions(saveDraft?: () => Promise<void>): { signIn(): void; linkGitHub(): void } {
  const a = useAccount()
  const gh = useGitHubLink()
  const save = async () => {
    await saveDraft?.().catch(() => undefined)
  }
  return {
    signIn: () => void save().then(() => a.signIn()).catch(() => undefined),
    linkGitHub: () => void save().then(() => gh.link()).catch(() => undefined),
  }
}

/**
 * The next identity step an action needs, as a call to action (sign in with the wallet, link GitHub, accept the current
 * terms, connect the session wallet); nothing once the identity is ready.
 */
export function ApiIdentityGate({ need, reason, className, saveDraft }: { need: IdentityNeed; reason: ReactNode; className?: string; saveDraft?: () => Promise<void> }) {
  const a = useAccount()
  const w = useWallet()
  const gh = useGitHubLink()
  const id = useApiIdentity()
  const actions = useIdentityActions(saveDraft)
  const siwe = a.backend?.siwe
  const step: SiweStep = siwe?.step ?? 'idle'
  const signing = step === 'challenge' || step === 'signing' || step === 'verifying'
  const signIn = actions.signIn

  if (id.status === 'loading') return <LoadingBlock lines={2} label="Checking your Pine session" className={className} />

  if (id.status === 'error') {
    // Unknown, not signed out: a sign-in prompt here would start a second session.
    return (
      <GatePanel title="Pine could not check your session" icon={<RotateCw size={18} aria-hidden />} className={className}>
        <p>{reason}</p>
        <p className="mt-2 text-[0.875rem] text-lumen-3">Pine did not answer. Your draft stays saved in this browser.</p>
        <Button variant="glass" className="mt-4" onClick={() => void a.refresh()} icon={<RotateCw size={15} aria-hidden />}>
          Try again
        </Button>
      </GatePanel>
    )
  }

  if (id.status === 'signed_out') {
    return (
      <GatePanel title="Sign in with your wallet" icon={<LogIn size={18} aria-hidden />} className={className}>
        <p>{reason}</p>
        <p className="mt-2 text-[0.875rem] text-lumen-3">Signing in costs no gas and authorizes no transaction. The message names Pine&apos;s terms, which signing accepts.</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {id.connected ? (
            <Button onClick={signIn} loading={signing} icon={<LogIn size={15} aria-hidden />}>
              Sign in with Ethereum
            </Button>
          ) : (
            <Button onClick={() => w.connect()} icon={<Wallet size={15} aria-hidden />}>
              Connect wallet
            </Button>
          )}
          <p className="text-[0.875rem] text-lumen-2" role="status" aria-live="polite">
            {SIWE_TEXT[step] ?? ''}
          </p>
        </div>
        {step === 'error' && siwe?.error && (
          <Notice tone="critical" role="alert" className="mt-4" title="Sign-in did not complete">
            <span className="untrusted">{siwe.error}</span>
          </Notice>
        )}
      </GatePanel>
    )
  }

  if (!id.github) {
    return (
      <GatePanel title="Link your GitHub account" icon={<Link2 size={18} aria-hidden />} className={className}>
        <p>{reason}</p>
        <p className="mt-2 text-[0.875rem] text-lumen-3">
          Pine reads public repositories through a GitHub app with no permissions, linked to your wallet. GitHub sends you back to Pine afterwards; this draft
          stays saved in this browser, so you can reopen it from Drafts.
        </p>
        <Button className="mt-4" onClick={actions.linkGitHub} loading={gh.busy} icon={<Link2 size={15} aria-hidden />}>
          Link GitHub
        </Button>
        {gh.error && (
          <Notice tone="critical" role="alert" className="mt-4" title="GitHub could not be linked">
            <span className="untrusted">{gh.error}</span>
          </Notice>
        )}
      </GatePanel>
    )
  }

  if (need === 'github') return null

  if (!id.sameWallet) {
    return (
      <GatePanel title="Connect the wallet you signed in with" icon={<Wallet size={18} aria-hidden />} className={className}>
        <p>
          The claim document names its creator, so {id.connected ? 'switch your wallet to' : 'connect'} {id.wallet ? <span className="t-code text-lumen">{shortAddress(id.wallet)}</span> : 'your signed-in wallet'}
          {id.connected ? ', or sign in again with the wallet you want to use.' : '.'}
        </p>
        {!id.connected && (
          <Button className="mt-4" onClick={() => w.connect()} icon={<Wallet size={15} aria-hidden />}>
            Connect wallet
          </Button>
        )}
      </GatePanel>
    )
  }

  if (need === 'publish' && !id.termsAccepted) {
    return (
      <GatePanel title="Pine's terms have changed" icon={<LogIn size={18} aria-hidden />} className={className}>
        <p>Publishing needs the current terms. Sign in again: the sign-in message names the new terms, and signing accepts them.</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={signIn} loading={signing} icon={<LogIn size={15} aria-hidden />}>
            Sign in again
          </Button>
          <p className="text-[0.875rem] text-lumen-2" role="status" aria-live="polite">
            {SIWE_TEXT[step] ?? ''}
          </p>
        </div>
      </GatePanel>
    )
  }

  return null
}
