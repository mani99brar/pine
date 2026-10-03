import { PineBackendError } from './http'

export interface PollOptions<T> {
  load(signal: AbortSignal): Promise<T>
  /** True once the value is final (polling stops). */
  done(value: T): boolean
  onValue?(value: T): void
  /** Delay between loads of a non-final value. */
  intervalMs: number
  /** Upper bound of the backoff after transient failures (default 60 s). */
  maxIntervalMs?: number
  /** Gives up after this many consecutive failures (default 8); the last error is thrown. */
  maxFailures?: number
  signal: AbortSignal
  /** Injectable for tests (default: setTimeout). */
  sleep?(ms: number, signal: AbortSignal): Promise<void>
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/** Transient failures worth waiting out: network, 429, 5xx (NOT_READY carries Retry-After). */
function isTransient(e: unknown): e is PineBackendError {
  return e instanceof PineBackendError && (e.apiCode === 'NETWORK' || e.status === 429 || e.status >= 500)
}

/**
 * Loads a status until it is final. Waits `intervalMs` between loads, honours Retry-After on 429/503, backs off
 * exponentially on network and 5xx failures, and rethrows anything else (or the last of `maxFailures` transient
 * failures). Resolves null when aborted.
 */
export async function pollUntil<T>(opts: PollOptions<T>): Promise<T | null> {
  const sleep = opts.sleep ?? defaultSleep
  const maxInterval = opts.maxIntervalMs ?? 60_000
  const maxFailures = opts.maxFailures ?? 8
  let failures = 0
  while (!opts.signal.aborted) {
    let wait = opts.intervalMs
    try {
      const value = await opts.load(opts.signal)
      if (opts.signal.aborted) return null
      failures = 0
      opts.onValue?.(value)
      if (opts.done(value)) return value
    } catch (e) {
      if (opts.signal.aborted) return null
      if (!isTransient(e)) throw e
      failures += 1
      if (failures >= maxFailures) throw e
      wait = e.retryAfter ? e.retryAfter * 1000 : Math.min(maxInterval, opts.intervalMs * 2 ** failures)
    }
    await sleep(Math.min(wait, maxInterval), opts.signal)
  }
  return null
}
