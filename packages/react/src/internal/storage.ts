/**
 * Safe key/value storage. Uses `window.localStorage` in the browser and an in-memory map on the
 * server, in private-mode browsers that throw on access, and in tests. Never touches `window`
 * at module load, so it is SSR-safe.
 */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const memory = new Map<string, string>()

export const memoryStorage: KeyValueStorage = {
  getItem: (k) => memory.get(k) ?? null,
  setItem: (k, v) => {
    memory.set(k, v)
  },
  removeItem: (k) => {
    memory.delete(k)
  },
}

/** Creates an isolated in-memory storage (tests, server). */
export function createMemoryStorage(): KeyValueStorage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v)
    },
    removeItem: (k) => {
      m.delete(k)
    },
  }
}

let cached: KeyValueStorage | undefined

export function getBrowserStorage(): KeyValueStorage {
  if (cached) return cached
  if (typeof window === 'undefined') return memoryStorage
  try {
    const ls = window.localStorage
    const probe = '__pine_probe__'
    ls.setItem(probe, '1')
    ls.removeItem(probe)
    cached = ls
  } catch {
    cached = memoryStorage
  }
  return cached
}

export function readJson<T>(storage: KeyValueStorage, key: string): T | null {
  try {
    const raw = storage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export function writeJson(storage: KeyValueStorage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    // Quota or serialization failure: progress stays in memory for this session.
  }
}

export function removeKey(storage: KeyValueStorage, key: string): void {
  try {
    storage.removeItem(key)
  } catch {
    // ignore
  }
}
