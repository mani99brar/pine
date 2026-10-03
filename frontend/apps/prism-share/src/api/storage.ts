/** localStorage access that never throws (private windows, blocked site data, sandboxed frames). */
const memory = new Map<string, string>()

function ls(): Storage | null {
  try {
    const s = window.localStorage
    const probe = '__pine_share_probe__'
    s.setItem(probe, '1')
    s.removeItem(probe)
    return s
  } catch {
    return null
  }
}

let cached: Storage | null | undefined

function storage(): Storage | null {
  if (cached === undefined) cached = typeof window === 'undefined' ? null : ls()
  return cached
}

export function readLocal<T>(key: string): T | null {
  try {
    const raw = storage()?.getItem(key) ?? memory.get(key) ?? null
    return raw === null ? null : (JSON.parse(raw) as T)
  } catch {
    return null
  }
}

export function writeLocal(key: string, value: unknown): void {
  const raw = JSON.stringify(value)
  try {
    const s = storage()
    if (s) s.setItem(key, raw)
    else memory.set(key, raw)
  } catch {
    memory.set(key, raw)
  }
}

export function removeLocal(key: string): void {
  memory.delete(key)
  try {
    storage()?.removeItem(key)
  } catch {
    /* ignore */
  }
}
