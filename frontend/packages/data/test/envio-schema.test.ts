import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import * as Q from '../src/envio/queries'

const here = dirname(fileURLToPath(import.meta.url))
const SCHEMA = readFileSync(resolve(here, '../../../docs/indexer/envio/schema.graphql'), 'utf8')
const CONFIG = readFileSync(resolve(here, '../../../docs/indexer/envio/config.example.yaml'), 'utf8')

/** type name → field name → base type name */
function parseSchema(src: string): Map<string, Map<string, string>> {
  const types = new Map<string, Map<string, string>>()
  const noDocs = src.replace(/"""[\s\S]*?"""/g, '').replace(/^\s*"[^"\n]*"\s*$/gm, '').replace(/#.*$/gm, '')
  for (const m of noDocs.matchAll(/type\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const fields = new Map<string, string>()
    for (const line of (m[2] ?? '').split('\n')) {
      const f = /^\s*(\w+)\s*:\s*\[?\s*(\w+)/.exec(line)
      if (f) fields.set(f[1]!, f[2]!)
    }
    types.set(m[1]!, fields)
  }
  return types
}

/** Tokenize a GraphQL document, dropping argument lists and comments. */
function tokens(q: string): string[] {
  const s = q.replace(/#.*$/gm, '')
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (/\s|,/.test(c)) {
      i++
    } else if (c === '(') {
      let depth = 0
      do {
        if (s[i] === '(') depth++
        else if (s[i] === ')') depth--
        i++
      } while (depth > 0 && i < s.length)
    } else if (c === '{' || c === '}' || c === ':') {
      out.push(c)
      i++
    } else {
      const m = /^[$\w]+/.exec(s.slice(i))
      if (!m) throw new Error(`unexpected ${c} in query`)
      out.push(m[0])
      i += m[0].length
    }
  }
  return out
}

const ROOTS: Record<string, string> = {
  Claim: 'Claim',
  PriceCandle: 'PriceCandle',
  Pool: 'Pool',
  Evidence: 'Evidence',
  ActivityEvent: 'ActivityEvent',
  Account_by_pk: 'Account',
  PlatformStats_by_pk: 'PlatformStats',
  DailyStats: 'DailyStats',
}

function checkQuery(name: string, query: string, types: Map<string, Map<string, string>>): string[] {
  const t = tokens(query)
  const start = t.indexOf('{')
  const problems: string[] = []
  const stack: (string | null)[] = [null] // null = root operation level
  let last: string | undefined
  for (let i = start + 1; i < t.length; i++) {
    const tok = t[i]!
    if (tok === '{') {
      const parent = stack[stack.length - 1] as string | null
      const child = parent === null ? (last ? ROOTS[last] : undefined) : last ? types.get(parent)?.get(last) : undefined
      if (!child) problems.push(`${name}: cannot resolve type of "${last}"`)
      stack.push(child ?? 'unknown')
    } else if (tok === '}') {
      stack.pop()
    } else if (t[i + 1] === ':') {
      i++ // alias, next token is the field
    } else {
      last = tok
      const parent = stack[stack.length - 1] as string | null
      if (parent === null) {
        if (!ROOTS[tok]) problems.push(`${name}: unknown root field ${tok}`)
      } else if (parent !== 'unknown' && !types.get(parent)?.has(tok)) {
        problems.push(`${name}: ${parent}.${tok} is not in schema.graphql`)
      }
    }
  }
  return problems
}

describe('Envio schema ↔ client queries', () => {
  const types = parseSchema(SCHEMA)

  it('defines every entity the frontend reads', () => {
    for (const e of ['Claim', 'Market', 'Outcome', 'Pool', 'PriceCandle', 'Trade', 'LiquidityPosition', 'Position', 'Evidence', 'OracleQuestion', 'OracleAnswer', 'Arbitration', 'ActivityEvent', 'Account', 'PlatformStats', 'DailyStats']) {
      expect(types.has(e), e).toBe(true)
      expect(types.get(e)?.get('id'), `${e}.id`).toBe('ID')
    }
  })

  it('every relation points at a defined type or scalar', () => {
    const scalars = new Set(['ID', 'String', 'Int', 'Float', 'Boolean', 'BigInt', 'BigDecimal', 'Bytes', 'Timestamp', 'Json'])
    const enums = new Set([...SCHEMA.matchAll(/enum\s+(\w+)/g)].map((m) => m[1]!))
    for (const [type, fields] of types) {
      for (const [field, base] of fields) {
        expect(scalars.has(base) || enums.has(base) || types.has(base), `${type}.${field}: ${base}`).toBe(true)
      }
    }
  })

  it.each(Object.entries(Q).filter(([k]) => !k.endsWith('_FIELDS')))('%s selects only schema fields', (name, query) => {
    expect(checkQuery(name, query as string, types)).toEqual([])
  })

  it('config.example.yaml uses Envio v3 `chains:` with Gnosis and Ethereum', () => {
    const cfg = YAML.parse(CONFIG) as { chains: { id: number; contracts: { name: string; address?: string }[] }[]; contracts: { name: string; events: { event: string }[] }[]; networks?: unknown }
    expect(cfg.networks).toBeUndefined()
    expect(cfg.chains.map((c) => c.id)).toEqual([100, 1])
    const events = cfg.contracts.flatMap((c) => c.events.map((e) => `${c.name}.${e.event.split('(')[0]}`))
    for (const e of [
      'MarketFactory.NewMarket',
      'ConditionalTokens.PositionSplit',
      'ConditionalTokens.PositionsMerge',
      'ConditionalTokens.PayoutRedemption',
      'Reality.LogNewQuestion',
      'Reality.LogNewAnswer',
      'Reality.LogNotifyOfArbitrationRequest',
      'Reality.LogFinalize',
      'ForeignProxy.Evidence',
      'ForeignProxy.Ruling',
      'AlgebraPool.Swap',
      'AlgebraPool.Mint',
      'AlgebraPool.Burn',
    ]) {
      expect(events).toContain(e)
    }
    const declared = new Set(cfg.contracts.map((c) => c.name))
    for (const chain of cfg.chains) for (const c of chain.contracts) expect(declared.has(c.name), c.name).toBe(true)
  })
})
