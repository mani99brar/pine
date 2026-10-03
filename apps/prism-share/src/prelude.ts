/**
 * Runs before any other module.
 * - Vite inlines the `process.env.*` keys listed in vite.config.ts; this minimal `process` keeps any
 *   other `process.env.X` read in shared code from throwing in the browser.
 * - zod v4 probes `new Function('')` to decide whether it may JIT-compile parsers. Under the artifact's
 *   CSP (no 'unsafe-eval') that probe is a CSP violation, so zod is told up front not to try.
 * - In a sandboxed or privacy-restricted frame, merely reading `window.localStorage` can throw. Parts of
 *   the shared data layer touch storage while the providers are created, so unusable storage is replaced
 *   by an in-memory Storage: the demo still works, it just forgets everything on reload.
 */
import { config as zodConfig } from 'zod/v4/core'

const g = globalThis as unknown as { process?: { env: Record<string, string | undefined>; browser?: boolean } }
if (typeof g.process === 'undefined') g.process = { env: { NODE_ENV: 'production' }, browser: true }

zodConfig({ jitless: true })

class MemoryStorage implements Storage {
  private map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  clear(): void {
    this.map.clear()
  }
  getItem(key: string): string | null {
    return this.map.has(String(key)) ? (this.map.get(String(key)) as string) : null
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.map.delete(String(key))
  }
  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value))
  }
}

function usable(name: 'localStorage' | 'sessionStorage'): boolean {
  try {
    const s = window[name]
    const probe = '__pine_share_probe__'
    s.setItem(probe, '1')
    s.removeItem(probe)
    return true
  } catch {
    return false
  }
}

if (typeof window !== 'undefined') {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    if (usable(name)) continue
    try {
      Object.defineProperty(window, name, { configurable: true, enumerable: true, value: new MemoryStorage() })
    } catch {
      /* cannot replace: the guarded code paths still fall back */
    }
  }
}
