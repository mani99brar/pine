'use client'

import Link from 'next/link'
import { useEffect, useRef, type ReactNode } from 'react'
import type { SiweStep } from '@pine/react'
import { useAccount, usePendingSiweTerms, useWallet, useWalletRestoring, useWalletSwitchNotice } from '@pine/react'
import { Check, LogIn, ShieldCheck, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { HashChip } from '@/components/ui/interactive'
import { Notice } from '@/components/ui/primitives'
import { CrystalGlyph } from '@/components/crystal/CrystalGlyph'
import { checksummed, shortAddress, walletNetworkName } from '@/components/shell/wallet-display'
import { cn } from '@/lib/cn'
import { focusAfter, takeFocus } from './focus'

const STEP_TEXT: Partial<Record<SiweStep, string>> = {
  connecting: 'Connect a wallet to continue.',
  challenge: 'Asking Pine for a sign-in message.',
  signing: 'Sign the message in your wallet.',
  verifying: 'Checking your signature.',
  done: 'Signed in.',
}

const PHASES: { step: SiweStep; label: string }[] = [
  { step: 'challenge', label: 'Message' },
  { step: 'signing', label: 'Signature' },
  { step: 'verifying', label: 'Verified' },
]

function phaseState(phase: SiweStep, step: SiweStep): 'done' | 'active' | 'todo' {
  const order: SiweStep[] = ['challenge', 'signing', 'verifying', 'done']
  const at = order.indexOf(step)
  const i = order.indexOf(phase)
  if (at < 0) return 'todo'
  return i < at ? 'done' : i === at ? 'active' : 'todo'
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: ReactNode }) {
  return (
    <li className="cut-lg well flex gap-3.5 p-4 sm:p-5">
      <span
        aria-hidden
        className={cn(
          'cut-sm inline-flex h-7 w-7 shrink-0 items-center justify-center border text-[0.8125rem] font-semibold',
          done ? 'border-hb text-hb' : 'border-edge-strong text-lumen-2',
        )}
      >
        {done ? <Check size={14} /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="font-semibold text-lumen">
          {title}
          {done && <span className="sr-only"> (done)</span>}
        </h3>
        {children}
      </div>
    </li>
  )
}

/** Pine could not be asked about the session (5xx, network error): the session is unknown until "Try again" works. */
export function SessionCheckFailed({ error, refresh, className }: { error: Error | null; refresh(): Promise<void>; className?: string }) {
  return (
    <Notice
      tone="critical"
      role="alert"
      className={className}
      title="Pine could not check your session"
      action={
        <Button size="sm" variant="glass" onClick={() => void refresh()}>
          Try again
        </Button>
      }
    >
      <span className="untrusted">{error?.message ?? 'Pine did not answer.'}</span>
    </Notice>
  )
}

/** `api` mode sign-in: connect a wallet (RainbowKit), then Sign-In with Ethereum against the Pine backend. */
export function ApiSignIn() {
  const a = useAccount()
  const wallet = useWallet()
  const restoring = useWalletRestoring()
  const pendingTerms = usePendingSiweTerms()
  const { notice, dismiss } = useWalletSwitchNotice()
  const siwe = a.backend?.siwe
  const step: SiweStep = siwe?.step ?? 'idle'
  const busy = step === 'challenge' || step === 'signing' || step === 'verifying'
  const address = wallet.isConnected ? wallet.address : undefined
  const heading = useRef<HTMLHeadingElement | null>(null)
  useEffect(() => {
    if (takeFocus('signed-out')) heading.current?.focus()
  }, [])
  const signIn = () => {
    focusAfter('signed-in')
    // The failure is shown from the hook's error state; focus stays on the button.
    void a.signIn().catch(() => takeFocus('signed-in'))
  }

  return (
    <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
      <div className="glass cut-xl p-6 sm:p-8">
        <h2 ref={heading} tabIndex={-1} className="t-h2 focus:outline-none">
          Sign in with your wallet
        </h2>
        <p className="mt-3 max-w-[58ch] text-lumen-2">
          Pine knows you by the wallet you sign in with. Browsing claims and reading briefs needs no account.
        </p>

        {notice && notice.state !== 'signing_out' && (
          <Notice
            tone="caution"
            role="status"
            className="mt-6"
            title="You were signed out"
            action={
              <Button size="sm" variant="ghost" onClick={dismiss}>
                Dismiss
              </Button>
            }
          >
            Your wallet switched from {shortAddress(notice.from)} to {shortAddress(notice.to)}. A Pine session belongs to the wallet that signed in, so sign
            in again with the wallet you want to use.
            {notice.state === 'failed' && ' The server could not confirm the sign-out; that session ends on its own after a period without use.'}
          </Notice>
        )}

        <ol className="mt-7 grid gap-3" aria-label="Sign-in steps">
          <Step n={1} done={Boolean(address)} title="Connect a wallet">
            {address ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <HashChip value={checksummed(address)} display={shortAddress(address)} name="Connected wallet" />
                <span className="text-[0.84375rem] text-lumen-3">{walletNetworkName(wallet.chainId)}</span>
              </div>
            ) : restoring ? (
              <p className="help mt-1" role="status">
                Reconnecting the wallet you used before…
              </p>
            ) : (
              <>
                <p className="help mt-1">A wallet that signs with its own key. Smart-contract wallets cannot sign in.</p>
                <Button variant="glass" className="mt-3" onClick={() => wallet.connect()} icon={<Wallet size={15} aria-hidden />}>
                  Connect wallet
                </Button>
              </>
            )}
          </Step>
          <Step n={2} done={step === 'done'} title="Sign the sign-in message">
            <p className="help mt-1">
              Pine sends a one-time message for this site, this wallet and Gnosis Chain. Your browser checks it before your wallet shows it.
            </p>
            <Button className="mt-3" onClick={signIn} loading={busy} disabled={!address} icon={<LogIn size={16} aria-hidden />}>
              Sign in with Ethereum
            </Button>
            {(busy || step === 'done') && (
              <ol className="mt-4 flex flex-wrap items-center gap-2" aria-label="Sign-in progress">
                {PHASES.map((p) => {
                  const state = step === 'done' ? 'done' : phaseState(p.step, step)
                  return (
                    <li
                      key={p.step}
                      className={cn('tag', state === 'done' && 'border-[rgba(90,216,255,0.45)] text-hb', state === 'active' && 'text-lumen')}
                      aria-current={state === 'active' ? 'step' : undefined}
                    >
                      {state === 'done' && <Check size={12} aria-hidden />}
                      {p.label}
                    </li>
                  )
                })}
              </ol>
            )}
            <p className="mt-2 min-h-[1.4em] text-[0.875rem] text-lumen-2" role="status" aria-live="polite">
              {STEP_TEXT[step] ?? ''}
            </p>
          </Step>
        </ol>

        <div className="mt-6 grid gap-2">
          <p className="flex items-start gap-2.5 text-[0.9375rem] text-lumen-2">
            <ShieldCheck size={18} aria-hidden className="mt-0.5 shrink-0 text-hb" />
            <span>
              Signing accepts Pine&apos;s terms, which the message names by their sha256 hash. It authorizes no transaction or spending, costs no gas, and
              only proves you control this address.
            </span>
          </p>
          {pendingTerms && (
            <div className="pl-7">
              <p className="text-[0.84375rem] text-lumen-2">
                Your wallet shows: &ldquo;Sign in to Pine. I accept the terms with sha256 <span className="t-code text-lumen">{pendingTerms}</span>.&rdquo;
              </p>
              <HashChip value={pendingTerms} label="Terms sha256" className="mt-2 max-w-full" />
            </div>
          )}
          <p className="pl-7 text-[0.84375rem] text-lumen-3">
            Read the{' '}
            <Link href="/risks" className="link">
              risks and launch gates
            </Link>{' '}
            before you fund or trade a market.
          </p>
        </div>

        {step === 'error' && siwe?.error && (
          <Notice tone="critical" role="alert" className="mt-6" title="Sign-in did not complete">
            <span className="untrusted">{siwe.error}</span>
          </Notice>
        )}
        {a.error && <SessionCheckFailed error={a.error} refresh={a.refresh} className="mt-6" />}
      </div>
      <div className="hidden justify-center lg:flex" aria-hidden>
        <CrystalGlyph seed="account:sign-in" hue="#5AD8FF" state="partial" cut={['commit', 'policy']} size={320} decorative />
      </div>
    </div>
  )
}
