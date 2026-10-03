import { keccak256, stringToBytes } from 'viem'
import type { Hex } from './types'

/**
 * RFC 8785-style canonical JSON (JCS).
 *
 * - Object keys sorted by UTF-16 code units (JS default string sort), no whitespace.
 * - Arrays keep their order.
 * - Numbers use the ECMAScript shortest round-trip form (same as RFC 8785); `-0` becomes `0`.
 * - Strings use JSON escaping (same as RFC 8785 for well-formed strings).
 * - Object properties whose value is `undefined` are omitted (like JSON.stringify).
 * - Throws on: NaN/±Infinity, `undefined` at the top level or inside arrays, functions, symbols,
 *   bigint (convert to a decimal string first), and circular references.
 * - Objects exposing `toJSON()` (e.g. Date) are serialized through it.
 *
 * Isomorphic and dependency-free (no Node APIs).
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$', new Set())
}

function serialize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`)
      return Object.is(value, -0) ? '0' : JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'undefined':
      throw new TypeError(`canonicalJson: undefined at ${path}`)
    case 'function':
      throw new TypeError(`canonicalJson: function at ${path}`)
    case 'symbol':
      throw new TypeError(`canonicalJson: symbol at ${path}`)
    case 'bigint':
      throw new TypeError(`canonicalJson: bigint at ${path} (convert to a decimal string first)`)
    case 'object':
      break
    default:
      throw new TypeError(`canonicalJson: unsupported value at ${path}`)
  }

  const obj = value as Record<string, unknown> & { toJSON?: () => unknown }
  if (typeof obj.toJSON === 'function') {
    return serialize(obj.toJSON(), path, seen)
  }
  if (seen.has(obj)) throw new TypeError(`canonicalJson: circular reference at ${path}`)
  seen.add(obj)
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((item, i) => serialize(item, `${path}[${i}]`, seen))
      return `[${parts.join(',')}]`
    }
    const keys = Object.keys(obj).sort()
    const parts: string[] = []
    for (const key of keys) {
      const v = obj[key]
      if (v === undefined) continue
      parts.push(`${JSON.stringify(key)}:${serialize(v, `${path}.${key}`, seen)}`)
    }
    return `{${parts.join(',')}}`
  } finally {
    seen.delete(obj)
  }
}

/** keccak256 of the UTF-8 bytes of `canonicalJson(value)`. */
export function hashJson(value: unknown): Hex {
  return keccak256(stringToBytes(canonicalJson(value)))
}

/** keccak256 of the UTF-8 bytes of `text` (no normalization). */
export function hashText(text: string): Hex {
  return keccak256(stringToBytes(text))
}

/** True for a 0x-prefixed 32-byte hex string. */
export function isHash32(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
}
