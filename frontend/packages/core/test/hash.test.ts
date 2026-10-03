import { describe, expect, it } from 'vitest'
import { canonicalJson, hashJson, hashText } from '../src/hash'

describe('canonicalJson', () => {
  it('sorts keys independent of insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(hashJson({ b: 1, a: 2 })).toBe(hashJson({ a: 2, b: 1 }))
  })
  it('sorts nested objects and keeps array order', () => {
    const v = { z: [3, 1, 2, { y: 1, x: [2, 1] }], a: { d: 1, c: null } }
    expect(canonicalJson(v)).toBe('{"a":{"c":null,"d":1},"z":[3,1,2,{"x":[2,1],"y":1}]}')
    expect(canonicalJson([[2, 1], [1, 2]])).toBe('[[2,1],[1,2]]')
  })
  it('has no whitespace and escapes strings', () => {
    expect(canonicalJson({ 'a b': 'x"y\n', u: 'é' })).toBe('{"a b":"x\\"y\\n","u":"é"}')
  })
  it('throws on non-finite numbers', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow()
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow()
    expect(() => canonicalJson([Number.NEGATIVE_INFINITY])).toThrow()
  })
  it('throws on undefined in arrays, functions, bigint, top-level undefined', () => {
    expect(() => canonicalJson([1, undefined])).toThrow()
    expect(() => canonicalJson({ f: () => 1 })).toThrow()
    expect(() => canonicalJson({ n: 1n })).toThrow()
    expect(() => canonicalJson(undefined)).toThrow()
  })
  it('omits undefined object props', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}')
  })
  it('throws on circular references but allows shared references', () => {
    const shared = { x: 1 }
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}')
    const c: Record<string, unknown> = {}
    c.self = c
    expect(() => canonicalJson(c)).toThrow()
  })
  it('normalizes numbers like RFC 8785', () => {
    expect(canonicalJson([-0, 1.5, 1e21, 1e-7, 100])).toBe('[0,1.5,1e+21,1e-7,100]')
  })
  it('serializes Dates via toJSON', () => {
    expect(canonicalJson({ d: new Date('2026-10-10T18:00:00Z') })).toBe('{"d":"2026-10-10T18:00:00.000Z"}')
  })
})

describe('hashJson / hashText', () => {
  it('is stable and keccak256 of UTF-8', () => {
    expect(hashText('')).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
    expect(hashJson({ a: 1 })).toBe(hashText('{"a":1}'))
    expect(hashJson({ nested: { b: [1, 2], a: 'x' } })).toBe(hashJson({ nested: { a: 'x', b: [1, 2] } }))
  })
})
