import { PineBackendError, type PineApiErrorCode, type PineApiIssue } from './http'

// Human messages for failed write actions. The backend's own messages are platform-authored but not stable, so the
// primary text is chosen here from the stable error code; the backend message is kept as `detail` (plain text only).

/** What the UI should offer next. */
export type WriteErrorAction =
  | 'sign_in' // the session expired or the terms changed: run SIWE again
  | 'link_github' // GitHub is not (or no longer) linked
  | 'repreview' // the publication offer expired or the draft changed: request a new preview
  | 'reload' // the resource changed elsewhere: reload it and try again
  | 'retry_later' // transient: try again after `retryAfter` seconds
  | 'fix_input' // invalid input: see `issues`
  | 'none'

export interface WriteErrorInfo {
  code: PineApiErrorCode | 'NETWORK' | 'BAD_RESPONSE' | 'PLAN_REJECTED' | 'UNKNOWN'
  message: string
  action: WriteErrorAction
  /** Seconds to wait before retrying (Retry-After). */
  retryAfter?: number
  /** Field issues of a validation failure (paths relative to the request body). */
  issues?: PineApiIssue[]
  /** The backend's (or verifier's) own explanation, for a details disclosure. */
  detail?: string
  status?: number
}

/**
 * A refusal by this app that clears up by itself, e.g. Pine's view of the chain is behind what the user's RPC reads.
 * Nothing was sent; the action can be tried again later.
 */
export class RetryLaterError extends Error {
  constructor(
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'RetryLaterError'
  }
}

/** "45 s", "3 min", "2 h 5 min". */
export function formatWait(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds))
  if (s < 90) return `${s} s`
  const minutes = Math.ceil(s / 60)
  if (minutes < 90) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`
}

const after = (retryAfter: number | undefined, fallback: string) => (retryAfter ? `Try again in ${formatWait(retryAfter)}.` : fallback)

function backend(e: PineBackendError): WriteErrorInfo {
  const base = { code: e.apiCode, detail: e.message, retryAfter: e.retryAfter, status: e.status }
  const text = e.message.toLowerCase()
  switch (e.apiCode) {
    case 'TERMS_REQUIRED':
      return { ...base, action: 'sign_in', message: 'Pine’s terms have changed. Sign in again to accept the current terms, then retry.' }
    case 'UNAUTHENTICATED':
      return { ...base, action: 'sign_in', message: 'Your Pine session has ended. Sign in with your wallet again.' }
    case 'STEP_UP_REQUIRED':
      return { ...base, action: 'sign_in', message: 'Sign in again to confirm this action.' }
    case 'UNAVAILABLE_FOR_LEGAL_REASONS':
      return { ...base, action: 'none', message: 'This action is not available for your wallet or region.' }
    case 'QUOTA_EXCEEDED':
      return { ...base, action: 'retry_later', message: `You reached your daily limit for this action. ${after(e.retryAfter, 'Try again later.')}` }
    case 'RATE_LIMITED':
      return { ...base, action: 'retry_later', message: `Too many requests right now. ${after(e.retryAfter, 'Try again shortly.')}` }
    case 'NOT_READY':
      if (text.includes('being created')) {
        return { ...base, action: 'retry_later', message: 'The claim is being created on chain. Pine is waiting for the transaction to become final.' }
      }
      return { ...base, action: 'retry_later', message: `Pine’s view of the chain is catching up, so it cannot prepare transactions yet. ${after(e.retryAfter, 'Try again shortly.')}` }
    case 'CONFLICT':
      if (text.includes('offer expired')) {
        return { ...base, action: 'repreview', message: 'The offer to publish this preview expired. Request a new preview to publish.' }
      }
      if (text.includes('github')) return { ...base, action: 'link_github', message: 'Connect your GitHub account again before publishing.' }
      if (text.includes('repository changed')) {
        return { ...base, action: 'repreview', message: 'The repository was renamed or transferred since the preview. Request a new preview.' }
      }
      if (text.includes('modified after this preview') || text.includes('digest does not match') || text.includes('another preview') || text.includes('no longer passes')) {
        return { ...base, action: 'repreview', message: 'The draft changed after this preview. Request a new preview.' }
      }
      if (text.includes('different wallet')) {
        return { ...base, action: 'repreview', message: 'The preview was made for another wallet. Connect that wallet or request a new preview.' }
      }
      if (text.includes('idempotency')) {
        return { ...base, action: 'reload', message: 'This request clashes with an earlier one that had different details. Start the action again.' }
      }
      if (text.includes('maximum loss')) {
        return { ...base, action: 'fix_input', issues: e.issues, message: 'The maximum loss changed since you reviewed it. Review the new figures and confirm again.' }
      }
      return { ...base, action: 'reload', message: 'This changed elsewhere while you were working. Reload and try again.' }
    case 'FORBIDDEN':
      if (text.includes('github')) return { ...base, action: 'link_github', message: 'Connect your GitHub account first.' }
      return { ...base, action: 'none', message: 'You are not allowed to do this.' }
    case 'VALIDATION_FAILED':
      return { ...base, action: 'fix_input', issues: e.issues, message: 'Some details are not valid. Correct the highlighted fields and try again.' }
    case 'BAD_REQUEST':
      return { ...base, action: 'fix_input', message: 'Pine could not read this request.' }
    case 'UNPROCESSABLE':
      // Refusals with an explanation composed by the backend from fixed text and numbers (never user content).
      return { ...base, action: 'fix_input', issues: e.issues, message: e.message }
    case 'NOT_FOUND':
      return { ...base, action: 'reload', message: 'Pine could not find this item. It may have been removed, or it belongs to another account.' }
    case 'GONE':
      return { ...base, action: 'reload', message: 'This item is no longer available.' }
    case 'PAYLOAD_TOO_LARGE':
      return { ...base, action: 'fix_input', message: 'The file or text is too large for Pine (files are limited to 256 KiB).' }
    case 'UNSUPPORTED_MEDIA_TYPE':
      return { ...base, action: 'fix_input', message: 'Pine does not accept this file type.' }
    case 'INTEGRITY_FAILED':
      return { ...base, action: 'retry_later', message: 'Pine could not verify the stored content against its digest. Try again later.' }
    case 'UPSTREAM_UNAVAILABLE':
      return { ...base, action: 'retry_later', message: `GitHub or the chain RPC did not answer. ${after(e.retryAfter, 'Try again shortly.')}` }
    case 'FEATURE_DISABLED':
      return { ...base, action: 'none', message: 'This policy or feature is disabled on this Pine deployment.' }
    case 'CSRF_REJECTED':
      return { ...base, action: 'reload', message: 'The request was refused as cross-site. Reload Pine and try again.' }
    case 'INTERNAL':
      return { ...base, action: 'retry_later', message: 'Pine failed unexpectedly. Try again later.' }
    case 'NETWORK':
      return { ...base, action: 'retry_later', message: 'Could not reach Pine. Check your connection and try again.' }
    case 'BAD_RESPONSE':
      return { ...base, action: 'retry_later', message: 'Pine answered with something this app does not understand, so nothing was done.' }
  }
}

/**
 * Describes any error thrown by a write action. Plan verification failures (PlanVerificationError and the client's own
 * plan checks, named `PlanVerificationError` or `PlanContentError`) say that nothing reached the wallet.
 */
export function describeWriteError(e: unknown): WriteErrorInfo {
  if (e instanceof PineBackendError) return backend(e)
  if (e instanceof Error) {
    if (e.name === 'PlanVerificationError' || e.name === 'PlanContentError') {
      return {
        code: 'PLAN_REJECTED',
        action: 'none',
        detail: e.message,
        message: `Pine proposed a transaction that this app could not verify, so nothing was sent to your wallet (${e.message}).`,
      }
    }
    if (e instanceof RetryLaterError) return { code: 'UNKNOWN', action: 'retry_later', message: e.message, retryAfter: e.retryAfter }
    if (e.name === 'AbortError') return { code: 'UNKNOWN', action: 'none', message: 'Cancelled.' }
    return { code: 'UNKNOWN', action: 'none', message: e.message || 'Something went wrong.' }
  }
  return { code: 'UNKNOWN', action: 'none', message: typeof e === 'string' && e ? e : 'Something went wrong.' }
}
