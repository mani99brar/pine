'use client'

import { useState, type ReactNode } from 'react'
import type { WriteErrorInfo } from '@pine/data'
import { Button } from '@/components/ui/Button'
import { Notice } from '@/components/ui/primitives'
import { useNowMs } from '@/lib/hooks'
import { useIdentityActions } from './identity'

// A failed backend write, with the one thing to do next: sign in again (session ended, terms changed), link GitHub
// again, request a new preview (offer expired, draft changed), or wait for Retry-After (NOT_READY, rate limits).
// Messages are chosen from the stable error code; the backend's own text is platform-authored and shown as plain text.

const TITLE: Partial<Record<WriteErrorInfo['code'], string>> = {
  TERMS_REQUIRED: 'Pine’s terms have changed',
  UNAUTHENTICATED: 'Your Pine session has ended',
  UNAVAILABLE_FOR_LEGAL_REASONS: 'Not available for this wallet or region',
  NOT_READY: 'Pine is not ready yet',
  RATE_LIMITED: 'Too many requests',
  QUOTA_EXCEEDED: 'Daily limit reached',
  PLAN_REJECTED: 'Nothing was sent to your wallet',
  VALIDATION_FAILED: 'Pine refused some details',
}

/** Seconds left of a Retry-After, counted on the shared clock from when this notice first rendered. */
function useCountdown(seconds: number | undefined): number {
  const now = useNowMs()
  const [startedAt, setStartedAt] = useState<number | null>(now)
  if (startedAt === null && now !== null) setStartedAt(now)
  const elapsed = startedAt !== null && now !== null ? (now - startedAt) / 1000 : 0
  return seconds ? Math.max(0, Math.ceil(seconds - elapsed)) : 0
}

interface WriteErrorNoticeProps {
  error: WriteErrorInfo
  /** Repeats the failed action (offered for transient errors). */
  onRetry?: () => void
  /** Goes back to request a new preview. */
  onRepreview?: () => void
  /** Saves pending draft edits before signing in again or linking GitHub. */
  saveDraft?: () => Promise<void>
  className?: string
}

export function WriteErrorNotice(props: WriteErrorNoticeProps) {
  // A new error starts its own countdown.
  return <ErrorNotice key={`${props.error.code}|${props.error.message}|${props.error.retryAfter ?? ''}`} {...props} />
}

function ErrorNotice({ error, onRetry, onRepreview, saveDraft, className }: WriteErrorNoticeProps) {
  const identity = useIdentityActions(saveDraft)
  const left = useCountdown(error.action === 'retry_later' ? error.retryAfter : undefined)
  let action: ReactNode = null
  if (error.action === 'sign_in') {
    action = (
      <Button size="sm" onClick={identity.signIn}>
        Sign in again
      </Button>
    )
  } else if (error.action === 'link_github') {
    action = (
      <Button size="sm" onClick={identity.linkGitHub} loading={identity.github.busy}>
        Link GitHub again
      </Button>
    )
  } else if (error.action === 'repreview' && onRepreview) {
    action = (
      <Button size="sm" onClick={onRepreview}>
        Request a new preview
      </Button>
    )
  } else if ((error.action === 'retry_later' || error.action === 'reload') && onRetry) {
    action = (
      <Button size="sm" variant="glass" onClick={onRetry} disabled={left > 0}>
        {left > 0 ? `Try again in ${left} s` : 'Try again'}
      </Button>
    )
  }
  return (
    <Notice tone={error.action === 'retry_later' ? 'caution' : 'critical'} role="alert" className={className} title={TITLE[error.code] ?? 'This did not go through'} action={action}>
      <span className="untrusted [white-space:normal]">{error.message}</span>
      {error.issues && error.issues.length > 0 && error.action === 'fix_input' && (
        <ul className="mt-1.5 grid gap-0.5 text-[0.84375rem]">
          {error.issues.slice(0, 8).map((i) => (
            <li key={`${i.path.join('.')}|${i.message}`} className="untrusted [overflow-wrap:anywhere]">
              {i.path.length > 0 ? `${i.path.join('.')}: ` : ''}
              {i.message}
            </li>
          ))}
        </ul>
      )}
      {error.detail && error.detail !== error.message && (
        <details className="mt-1.5 text-[0.8125rem] text-lumen-3">
          <summary className="cursor-pointer">Details from Pine</summary>
          <span className="untrusted [white-space:normal]">{error.detail}</span>
        </details>
      )}
      {error.action === 'link_github' && identity.github.error && (
        <span className="untrusted mt-1.5 block text-[0.84375rem]">GitHub could not be linked: {identity.github.error}</span>
      )}
    </Notice>
  )
}
