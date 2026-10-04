'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { parseUnits } from 'viem'
import { shortHash } from '@pine/core'
import { formatWait, type WriteErrorInfo } from '@pine/data'
import { usePineSession, useSiweSignIn, useWallet, type ApiPlanRunner } from '@pine/react'
import { ShieldCheck, Wallet } from 'lucide-react'
import { TxSteps } from '@/components/tx/TxSteps'
import { Button } from '@/components/ui/Button'
import { Notice, Skeleton } from '@/components/ui/primitives'
import { useMounted } from '@/lib/hooks'
import { cn } from '@/lib/cn'

// Shared pieces of the api-mode action panels (evidence, oracle, funding, exits): the session gate, plan progress and
// error display, and exact decimal → wei parsing for amounts the user types.

const DECIMAL = /^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?$/

/** "12.5" → 12.5 × 10^18 (exact); null for anything that is not a plain positive decimal with at most 18 places. */
export function parseAmountWei(input: string): bigint | null {
  const v = input.trim().replace(',', '.')
  if (!DECIMAL.test(v)) return null
  try {
    const wei = parseUnits(v, 18)
    return wei > 0n ? wei : null
  } catch {
    return null
  }
}

/** True when the connected wallet has its own Pine session with the current terms accepted. */
export function useSessionReady(): boolean {
  const wallet = useWallet()
  const session = usePineSession()
  const s = session.session
  return Boolean(wallet.isConnected && wallet.address && s && s.termsAccepted && s.wallet.toLowerCase() === wallet.address.toLowerCase())
}

/**
 * Write actions in api mode need the Pine session of the connected wallet (SEC-AUTH-13) with the current terms
 * accepted. Until then this shows what to do instead of the action (and nothing else when there are no children).
 */
export function ApiSessionGate({ children, purpose, className }: { children?: ReactNode; purpose: string; className?: string }) {
  const mounted = useMounted()
  const wallet = useWallet()
  const session = usePineSession()
  const siwe = useSiweSignIn()
  if (!mounted || (wallet.isConnected && session.status === 'loading')) return <Skeleton className={cn('h-16 w-full', className)} />
  if (!wallet.isConnected || !wallet.address) {
    return (
      <div className={className}>
        <p className="text-[0.9rem] text-lumen-2">Connect a wallet to {purpose}.</p>
        <Button variant="glass" size="sm" className="mt-3" onClick={() => wallet.connect()} icon={<Wallet size={14} aria-hidden />}>
          Connect wallet
        </Button>
      </div>
    )
  }
  const s = session.session
  const otherWallet = s !== null && s.wallet.toLowerCase() !== wallet.address.toLowerCase()
  if (s && !otherWallet && s.termsAccepted) return <>{children}</>
  const text = !s
    ? `Sign in to Pine with this wallet to ${purpose}. Signing a message proves you control the wallet and accepts Pine’s terms; it sends no transaction and costs nothing.`
    : otherWallet
      ? `You are signed in to Pine as ${shortHash(s.wallet)}, but your wallet is now ${shortHash(wallet.address)}. Sign in again with this wallet, or switch back.`
      : 'Pine’s terms have changed. Sign in again to accept the current terms.'
  return (
    <div className={className}>
      <p className="text-[0.9rem] text-lumen-2">{text}</p>
      <Button
        variant="glass"
        size="sm"
        className="mt-3"
        loading={siwe.step === 'challenge' || siwe.step === 'signing' || siwe.step === 'verifying'}
        onClick={() => void siwe.signIn().catch(() => undefined)}
        icon={<ShieldCheck size={14} aria-hidden />}
      >
        Sign in with Ethereum
      </Button>
      {siwe.error && (
        <p className="untrusted mt-2 text-[0.84375rem] text-ha" role="alert">
          {siwe.error}
        </p>
      )}
    </div>
  )
}

/** A write error: the chosen message, what to do next, and the platform's own detail behind a disclosure. */
export function WriteErrorNotice({ error, className }: { error: WriteErrorInfo | null; className?: string }) {
  if (!error) return null
  return (
    <Notice tone={error.action === 'retry_later' ? 'caution' : 'critical'} role="alert" className={className}>
      <span className="untrusted [white-space:normal]">{error.message}</span>
      {error.retryAfter ? <span className="block text-[0.84375rem] text-lumen-3">Wait {formatWait(error.retryAfter)} before trying again.</span> : null}
      {error.action === 'sign_in' && (
        <Link href="/account" className="link mt-1 block text-[0.84375rem]">
          Sign in on your account page
        </Link>
      )}
      {error.issues && error.issues.length > 0 && (
        <ul className="mt-1 grid gap-0.5 text-[0.84375rem]">
          {error.issues.slice(0, 8).map((i, n) => (
            <li key={n} className="untrusted">
              {i.path.length > 0 ? <span className="t-code text-lumen-3">{i.path.join('.')}: </span> : null}
              {i.message}
            </li>
          ))}
        </ul>
      )}
      {error.detail && error.detail !== error.message && (
        <details className="mt-1 text-[0.8125rem] text-lumen-3">
          <summary className="cursor-pointer">Details</summary>
          <span className="untrusted block">{error.detail}</span>
        </details>
      )}
    </Notice>
  )
}

/**
 * Progress of one backend plan: Pine prepares it, this app verifies every step against the pinned deployment and the
 * chain, then the wallet signs each verified step.
 */
export function PlanProgress({ runner, chainId, className }: { runner: ApiPlanRunner; chainId: number; className?: string }) {
  if (runner.phase === 'planning') {
    return (
      <p className={cn('flex items-center gap-2 text-[0.875rem] text-lumen-2', className)} role="status">
        <span className="spinner" aria-hidden /> Pine is preparing the transactions. This app verifies each one before your wallet sees it.
      </p>
    )
  }
  if (runner.runner.steps.length === 0) return null
  return (
    <div className={className}>
      <p className="mb-3 text-[0.8125rem] text-lumen-3">Verified against Pine&apos;s pinned contracts before signing</p>
      <TxSteps runner={runner.runner} chainId={chainId} />
    </div>
  )
}

/**
 * Retry, continue or forget a plan that stopped (a failed step, an expired offer, a reload part way). `onRetry` must go
 * through the plan runner's `run()`, which verifies the stored plan again before anything is sent. Nothing is offered
 * while a step is running, and a plan is not forgotten while one of its transactions may still land.
 */
export function PlanControls({ runner, onRetry, onAbandon, busy }: { runner: ApiPlanRunner; onRetry: () => void; onAbandon: () => void; busy: boolean }) {
  const failed = runner.runner.state === 'failed' || runner.phase === 'error'
  if ((!failed && !runner.canResume) || busy) return null
  const mayLand = runner.runner.steps.some((s) => s.status === 'pending' || s.status === 'awaiting_signature')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={onRetry}>
        {failed ? 'Try again' : 'Continue'}
      </Button>
      {!mayLand && (
        <Button size="sm" variant="ghost" onClick={onAbandon}>
          Start over
        </Button>
      )}
    </div>
  )
}
