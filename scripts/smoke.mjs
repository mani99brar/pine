#!/usr/bin/env node
/**
 * Cross-app smoke test.
 * Crawls each running app from "/" following same-origin links (BFS, capped), then hits the
 * agent-facing endpoints every app must serve. Fails on any non-2xx or on forbidden copy.
 *
 * Usage: node scripts/smoke.mjs [baseUrl ...]
 * Default: http://localhost:3001 http://localhost:3002 http://localhost:3003
 */
const bases = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003']

const MAX_PAGES = Number(process.env.SMOKE_MAX_PAGES ?? 80)
const AGENT_PATHS = [
  '/llms.txt',
  '/llms-full.txt',
  '/.well-known/pine.json',
  '/api/agent/v1/claims',
  '/api/agent/v1/claims?status=open',
  '/api/agent/v1/policies',
  '/api/agent/v1/schema/claim-manifest.json',
  '/api/agent/v1/openapi.json',
  '/api/agent/v1/feed.xml',
]
// Words the product must never use to describe outcomes (spec §8). Checked on visible text only.
const FORBIDDEN = [/\bcertified\b/i, /\baudited\b/i, /\bverified correct\b/i, /\bbug-free\b/i, /\bguaranteed (refund|reward|payout)\b/i]

const stripTags = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')

let failures = 0
const fail = (msg) => {
  failures++
  console.log(`  ✗ ${msg}`)
}

for (const base of bases) {
  console.log(`\n▶ ${base}`)
  const seen = new Set()
  const queue = ['/']
  let pages = 0
  while (queue.length && pages < MAX_PAGES) {
    const path = queue.shift()
    if (seen.has(path)) continue
    seen.add(path)
    pages++
    let res
    try {
      res = await fetch(base + path, { redirect: 'manual' })
    } catch (e) {
      fail(`${path} → network error ${e.message}`)
      continue
    }
    const ok = res.status < 400
    if (!ok) fail(`${path} → ${res.status}`)
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('text/html')) continue
    const html = await res.text()
    const text = stripTags(html)
    for (const re of FORBIDDEN) {
      const m = text.match(re)
      if (m) {
        // allow negated usage, e.g. "not certified", "never audited"
        const idx = text.search(re)
        const before = text.slice(Math.max(0, idx - 40), idx).toLowerCase()
        if (!/(not|never|no|isn't|is not|without|nor|n't)\s+(\w+\s+){0,3}$/.test(before)) fail(`${path} uses forbidden wording "${m[0]}" …${text.slice(Math.max(0, idx - 60), idx + 40).replace(/\s+/g, ' ')}…`)
      }
    }
    for (const m of html.matchAll(/href="(\/[^"#?]*)(\?[^"#]*)?"/g)) {
      const href = m[1]
      if (href.startsWith('/_next') || href.startsWith('/api/auth')) continue
      if (/\.(png|jpg|svg|ico|css|js|webmanifest|xml|txt|json)$/.test(href)) continue
      if (!seen.has(href) && !queue.includes(href)) queue.push(href)
    }
  }
  console.log(`  crawled ${pages} pages`)
  for (const path of AGENT_PATHS) {
    try {
      const res = await fetch(base + path)
      if (!res.ok) fail(`${path} → ${res.status}`)
      else console.log(`  ✓ ${path} (${res.headers.get('content-type')})`)
    } catch (e) {
      fail(`${path} → ${e.message}`)
    }
  }
  // one claim brief + manifest
  try {
    const list = await (await fetch(base + '/api/agent/v1/claims')).json()
    const first = (list.items ?? list.claims ?? list.data ?? [])[0]
    if (!first) fail('agent claims list is empty')
    else {
      for (const p of [`/api/agent/v1/claims/${first.id}`, `/api/agent/v1/claims/${first.id}?format=md`, `/api/agent/v1/claims/${first.id}/manifest.json`]) {
        const r = await fetch(base + p)
        if (!r.ok) fail(`${p} → ${r.status}`)
        else console.log(`  ✓ ${p}`)
      }
    }
  } catch (e) {
    fail(`agent claim detail → ${e.message}`)
  }
}

console.log(failures ? `\n${failures} failure(s)` : '\nall smoke checks passed')
process.exit(failures ? 1 : 0)
