'use client'

import { useState } from 'react'
import { useAccount } from '@pine/react'
import { LogIn, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Notice } from '@/components/ui/primitives'
import { CrystalGlyph } from '@/components/crystal/CrystalGlyph'

export function SignIn() {
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
    <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
      <div className="glass cut-xl p-6 sm:p-8">
        <h2 className="t-h2">Sign in</h2>
        <p className="mt-3 max-w-[56ch] text-lumen-2">Your account holds your GitHub identity, the wallets you link, and your defaults. Browsing claims and reading briefs needs no account.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          {a.providers.github && (
            <Button size="lg" onClick={() => void go('github')} loading={busy === 'github'} icon={<LogIn size={17} aria-hidden />}>
              Sign in with GitHub
            </Button>
          )}
          {a.providers.demo && (
            <Button size="lg" variant={a.providers.github ? 'glass' : 'light'} onClick={() => void go('demo')} loading={busy === 'demo'}>
              {a.providers.github ? 'Use the demo identity' : 'Sign in with the demo identity'}
            </Button>
          )}
        </div>
        <div className="mt-8 grid gap-3">
          <p className="flex items-start gap-2.5 text-[0.9375rem] text-lumen-2">
            <ShieldCheck size={18} aria-hidden className="mt-0.5 shrink-0 text-hb" />
            <span>
              Pine asks GitHub only for the <code className="t-code text-lumen">read:user</code> scope: your public profile. It cannot read private repositories, write code, open pull requests, merge or deploy anything.
            </span>
          </p>
          <p className="pl-7 text-[0.84375rem] text-lumen-3">Your GitHub access token stays on the server and is never placed in your session or sent to the browser.</p>
        </div>
        {!a.providers.github && <Notice tone="info" className="mt-6">GitHub sign-in is not configured for this deployment, so a demo identity is used. Everything works, and nothing leaves this demo.</Notice>}
        {a.error && (
          <Notice tone="critical" className="mt-6" role="alert">
            {a.error.message}
          </Notice>
        )}
      </div>
      <div className="hidden justify-center lg:flex" aria-hidden>
        <CrystalGlyph seed="account:sign-in" hue="#5AD8FF" state="partial" cut={['commit', 'policy']} size={320} decorative />
      </div>
    </div>
  )
}
