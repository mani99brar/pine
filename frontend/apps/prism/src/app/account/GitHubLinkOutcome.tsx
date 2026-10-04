'use client'

import { useEffect, useRef } from 'react'
import { announceSessionChange, useAccount, useGitHubLink } from '@pine/react'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Notice } from '@/components/ui/primitives'
import { CrystalGlyph } from '@/components/crystal/CrystalGlyph'
import { shortAddress } from '@/components/shell/wallet-display'
import { useMounted } from '@/lib/hooks'

/**
 * Where the backend's GitHub callback lands (`/settings?github=linked|error`): the outcome, read back from the session
 * (the callback rotated the session cookie), then on to the account page.
 */
export function GitHubLinkOutcome({ outcome }: { outcome: 'linked' | 'error' }) {
  const mounted = useMounted()
  const a = useAccount()
  const gh = useGitHubLink()
  const heading = useRef<HTMLHeadingElement | null>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])

  const loading = !mounted || a.status === 'loading'
  const wallet = a.backend?.wallet ? shortAddress(a.backend.wallet) : null
  const login = a.backend?.github?.login ?? null
  const signedIn = !loading && a.status === 'signed_in'
  const read = !loading && a.status !== 'error'

  // Other tabs of this browser learn about the new link once this tab has read it back.
  const announced = useRef(false)
  useEffect(() => {
    if (!read || announced.current) return
    announced.current = true
    announceSessionChange()
  }, [read])

  let detail: string
  if (loading) detail = 'Checking your session.'
  else if (outcome === 'linked') {
    if (signedIn && login) detail = `Your wallet ${wallet ?? ''} is linked to GitHub as @${login}.`
    else if (signedIn) detail = 'GitHub confirmed the link, but your session does not show it yet. Your account page shows the current state.'
    else detail = 'Your Pine session has ended. Sign in with your wallet on your account page; the GitHub link is kept.'
  } else if (signedIn && login) {
    detail = `Nothing changed: your wallet is still linked to GitHub as @${login}.`
  } else {
    detail =
      'Nothing changed. This happens when the GitHub authorization was cancelled or took longer than 10 minutes, when your Pine session had ended, or when this GitHub account is already linked to another wallet.'
  }

  return (
    <div className="grid items-center gap-10 py-12 sm:py-16 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
      <div className="glass cut-xl p-6 sm:p-8">
        <h1 ref={heading} tabIndex={-1} className="t-h2 focus:outline-none">
          {outcome === 'linked' ? 'GitHub linked' : 'GitHub was not linked'}
        </h1>
        <p className="mt-3 max-w-[60ch] text-lumen-2" role="status" aria-live="polite">
          {detail}
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <ButtonLink href="/account">Continue to your account</ButtonLink>
          {outcome === 'error' && signedIn && !login && (
            <Button variant="glass" onClick={() => void gh.link().catch(() => undefined)} loading={gh.busy}>
              Try linking again
            </Button>
          )}
        </div>
        {gh.error && (
          <Notice tone="critical" role="alert" className="mt-5" title="GitHub could not be linked">
            <span className="untrusted">{gh.error}</span>
          </Notice>
        )}
      </div>
      <div className="hidden justify-center lg:flex" aria-hidden>
        <CrystalGlyph
          seed="account:github-link"
          hue="#5AD8FF"
          state={outcome === 'linked' ? 'luminous' : 'unlit'}
          cut={outcome === 'linked' ? undefined : ['commit']}
          size={260}
          decorative
        />
      </div>
    </div>
  )
}
