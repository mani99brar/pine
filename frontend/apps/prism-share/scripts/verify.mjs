// End-to-end verification of the static build, the way the artifact host runs it.
//
//   pnpm --filter @pine/app-prism-share build
//   node scripts/verify.mjs                desktop 1440×900
//   node scripts/verify.mjs --mobile       390×844
//   node scripts/verify.mjs --only=journey-a|journey-b|routes
//
// dist/ is served under a nested path (/a/b/c/) with a CSP close to the artifact's (no 'unsafe-eval'),
// inside <iframe sandbox="allow-scripts allow-same-origin">. Every request, console error, page error and
// CSP violation (from any frame) is recorded. Screens go to $QA_DIR (default: apps/prism-share/.qa).
// Exit code 1 when a journey fails or anything above is non-zero.
import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './serve.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const mobile = args.includes('--mobile')
const only = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] ?? ''
const tag = mobile ? 'm' : 'd'
const OUT = process.env.QA_DIR ?? join(here, '..', '.qa')
const PORT = Number(process.env.PORT ?? 4173)
const BASE = '/a/b/c/'
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, 'fonts.googleapis.com', 'fonts.gstatic.com'])

await mkdir(OUT, { recursive: true })

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------
const serverLog = []
const server = await startServer({ port: PORT, base: BASE, onRequest: (e) => serverLog.push({ ...e }) })
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const ctx = await browser.newContext({
  viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: 'dark',
  reducedMotion: 'no-preference',
  // No clipboard permission: like the artifact frame, copy falls back to execCommand or a text box.
})
await ctx.addInitScript(({ base, fast }) => {
  if (!location.pathname.startsWith(base)) return
  // Same switch as Prism's ?qa=1 (query strings never reach an artifact): near-instant simulated
  // transactions. REALISTIC=1 keeps the delays a visitor sees.
  try {
    if (fast) sessionStorage.setItem('pine-prism:qa', '1')
  } catch {
    /* storage blocked: realistic delays */
  }
  document.addEventListener('securitypolicyviolation', (e) => {
    console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || '(inline)'} at ${e.sourceFile}:${e.lineNumber}`)
  })
}, { base: BASE, fast: process.env.REALISTIC !== '1' })

const page = await ctx.newPage()
page.setDefaultTimeout(30000)
const record = { requests: [], external: [], failed: [], httpErrors: [], console: [], pageErrors: [], heroColdFallbacks: 0 }
let step = 'start'
page.on('request', (r) => {
  const u = new URL(r.url())
  if (u.protocol === 'data:' || u.protocol === 'blob:') return
  record.requests.push(r.url())
  // The harness page itself is the "claude.ai" side, not the artifact.
  if (!ALLOWED_HOSTS.has(u.host)) record.external.push({ url: r.url(), step })
})
page.on('requestfailed', (r) => {
  const t = r.failure()?.errorText ?? ''
  // Navigations aborted by the test itself (frame reloads) are not app failures.
  if (/ERR_ABORTED/.test(t) && r.resourceType() === 'document') return
  record.failed.push({ url: r.url(), error: t, step })
})
page.on('response', (r) => {
  if (r.status() >= 400) record.httpErrors.push({ url: r.url(), status: r.status(), step })
})
page.on('console', (m) => {
  if (m.type() !== 'error') return
  record.console.push({ text: m.text().slice(0, 600), step, frame: m.location()?.url })
})
page.on('pageerror', (e) => record.pageErrors.push({ text: String(e).slice(0, 600), step }))

const results = []
function log(...a) {
  console.log(...a)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function open(route = '/') {
  await page.goto(`http://localhost:${PORT}/host.html?route=${encodeURIComponent(route)}`, { waitUntil: 'load' })
  const f = app()
  if (!f) throw new Error('app frame not found')
  await f.waitForSelector('main#main', { timeout: 20000 })
  return f
}
const app = () => page.frames().find((fr) => fr.url().includes(BASE))
async function shot(name) {
  await page.waitForTimeout(450)
  await page.screenshot({ path: join(OUT, `${tag}-${name}.png`) })
}
async function waitRoute(prefix) {
  await app().waitForFunction((p) => location.hash.startsWith(`#${p}`), prefix, { timeout: 20000 })
  await page.waitForTimeout(500)
}
async function scrollTo(y) {
  await app().evaluate((y) => window.scrollTo(0, y), y)
  await page.waitForTimeout(700)
}
async function clickLink(href, { within } = {}) {
  const f = app()
  const loc = (within ? f.locator(within) : f).locator(`a[href="#${href}"]:visible`).first()
  await loc.scrollIntoViewIfNeeded()
  await loc.click()
}
/** Opens the mobile navigation sheet and follows one of its links. */
async function mobileNav(href) {
  const f = app()
  await f.evaluate(() => window.scrollTo(0, 0))
  await f.getByRole('button', { name: 'Open navigation' }).click()
  const dlg = f.getByRole('dialog')
  await dlg.waitFor()
  await page.waitForTimeout(450)
  await dlg.locator(`a[href="#${href}"]`).first().click()
}
async function journey(name, fn) {
  if (only && !name.includes(only)) return
  const before = errCount()
  const t0 = Date.now()
  try {
    await fn()
    const errs = errCount() - before
    results.push({ name, ok: errs === 0, errors: errs, ms: Date.now() - t0 })
    log(`${errs === 0 ? '✓' : '!'} ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${errs ? `, ${errs} errors` : ''}`)
  } catch (e) {
    results.push({ name, ok: false, error: String(e).slice(0, 400), step, ms: Date.now() - t0 })
    log(`✗ ${name} at "${step}": ${String(e).split('\n')[0]}`)
    await shot(`${name}-failure`).catch(() => {})
  }
}
const errCount = () => record.console.length + record.pageErrors.length + record.failed.length + record.httpErrors.length + record.external.length
const S = (s) => {
  step = s
  log(`  · ${s}`)
}

// ---------------------------------------------------------------------------
// Journey A: landing hero (WebGL) → light table → PINE-0009 → composer → publish with failure, resume, seal
// ---------------------------------------------------------------------------
await journey('journey-a', async () => {
  S('landing: WebGL hero renders')
  let f = await open('/')
  // Headless Chromium renders WebGL with SwiftShader, which pays a one-time ~5 s start-up on the first full
  // context of a renderer process. That can exceed Prism's 4.5 s hero budget, after which the hero shows
  // its poster by design. A machine with a GPU does not pay it, so a cold fallback gets one reload (warm
  // process, like a returning visit) and the scene must then render.
  await f.waitForSelector('.hp[data-mode="gl"], .hp[data-mode="play"]', { timeout: 15000 })
  if ((await f.evaluate(() => document.querySelector('.hp')?.getAttribute('data-mode'))) === 'play') {
    record.heroColdFallbacks += 1
    log('    (cold SwiftShader start exceeded the 4.5 s hero budget: poster shown; reloading once)')
    await f.evaluate(() => location.reload())
    await page.waitForTimeout(400)
    f = app()
    await f.waitForSelector('main#main')
  }
  await f.waitForSelector('.hp[data-mode="gl"]', { timeout: 15000 })
  const canvas = await f.evaluate(() => {
    const c = document.querySelector('.hero-grid canvas')
    return c ? { w: c.width, h: c.height } : null
  })
  if (!canvas || canvas.w < 100) throw new Error('hero canvas missing')
  await page.waitForTimeout(2600) // let the ~2.8 s reveal finish
  await shot('a01-landing-hero')

  S('landing: scroll story')
  const height = await f.evaluate(() => document.documentElement.scrollHeight)
  const stops = [0.12, 0.25, 0.4, 0.55, 0.75, 0.95].map((r) => Math.round(r * height))
  for (const [i, y] of stops.entries()) {
    await scrollTo(y)
    if (i % 2 === 1) await shot(`a02-landing-scroll-${i}`)
  }
  await scrollTo(0)

  S('light table')
  await clickLink('/claims', { within: '#main' })
  await waitRoute('/claims')
  await f.getByRole('heading', { name: 'Light table', level: 1 }).waitFor()
  await page.waitForTimeout(1200)
  await shot('a03-light-table')

  S('open PINE-0009 from the table')
  await clickLink('/claims/pine-0009', { within: '#main' })
  await waitRoute('/claims/pine-0009')
  await f.getByRole('heading', { name: /Reporter deposits never draw principal/, level: 1 }).waitFor()
  await page.waitForTimeout(800)
  await shot('a04-claim-0009')

  S('composer: open')
  if (mobile) {
    await mobileNav('/compose')
  } else {
    await f.locator('header a[href="#/compose"]').filter({ hasText: 'New claim' }).click()
  }
  await waitRoute('/compose?draft=')
  await f.locator('#source-input').waitFor()
  await shot('a05-compose-source')

  S('composer: source (Enter submits the form inside the sandbox)')
  await f.locator('#source-input').fill('kleros/gateway-balancer-bot/pull/47')
  await f.getByRole('button', { name: 'Pin this commit' }).waitFor({ timeout: 20000 })
  await f.locator('#source-input').press('Enter')
  await f.getByRole('button', { name: /Continue to policy/ }).waitFor({ timeout: 20000 })
  await shot('a06-compose-pinned')
  await f.getByRole('button', { name: /Continue to policy/ }).click()

  S('composer: policy')
  await f.getByRole('radio', { name: /BOT-001/ }).first().click()
  await page.waitForTimeout(400)
  await f.getByRole('button', { name: /Continue to claim/ }).click()

  S('composer: claim (facet cutting)')
  await f.locator('#title').fill('Reporter deposits never draw principal from arbitration reserves')
  await f.locator('#requirement').fill('Reporter top-ups are funded only from eligible bridging-fee allocations, never from the arbitration allocation or the operator gas reserve.')
  await f.locator('#violation').fill('that reporter-deposit principal can be funded from the arbitration allocation or the operator gas reserve')
  await f.locator('#in-scope').fill('src/funding/reporter-planner.ts')
  await f.locator('#in-scope').press('Enter')
  for (const p of await f.locator('input[id^="param-"], textarea[id^="param-"], select[id^="param-"]').all()) {
    const tagName = await p.evaluate((el) => el.tagName)
    if (tagName === 'SELECT') {
      const v = await p.evaluate((el) => el.options[1]?.value ?? '')
      if (v) await p.selectOption(v)
    } else if (tagName === 'TEXTAREA') {
      if (!(await p.inputValue())) await p.fill('Spec section 4.2: reporter funding uses eligible bridging-fee allocations only.')
    } else if ((await p.getAttribute('type')) !== 'checkbox') {
      if (!(await p.inputValue())) {
        await p.fill('reporter funding planner')
        await p.press('Enter')
      }
    }
  }
  for (const group of await f.locator('div[id^="param-"]').all()) {
    if (!(await group.locator('button[aria-pressed="true"]').count())) await group.locator('button').first().click()
  }
  await page.waitForTimeout(600)
  await shot('a07-compose-claim')
  await f.getByRole('button', { name: /Continue to environment/ }).click()

  S('composer: environment, deadlines, funding, review')
  await f.locator('#runtime').fill('node 22.14.0')
  await f.locator('#repro').fill('pnpm vitest run test/reporter-funding.spec.ts')
  await page.waitForTimeout(400)
  await f.getByRole('button', { name: /Continue to deadlines/ }).click()
  await page.waitForTimeout(400)
  await f.getByRole('button', { name: /Continue to funding/ }).click()
  await page.waitForTimeout(400)
  await shot('a08-compose-funding')
  await f.getByRole('button', { name: /Continue to review/ }).click()
  await page.waitForTimeout(500)
  await shot('a09-compose-review')
  await f.locator('label:has-text("I have read these risks") input').check()
  await f.getByRole('button', { name: /Continue to publish/ }).click()

  S('composer: connect the demo wallet')
  await page.waitForTimeout(600)
  const connect = f.getByRole('button', { name: /Connect demo wallet/ }).first()
  if (await connect.count()) await connect.click()
  await page.waitForTimeout(500)
  await shot('a10-compose-publish')

  S('composer: arm a simulated failure and publish')
  const fail = f.getByRole('button', { name: /Fail next|fail the next transaction/i }).first()
  await fail.click()
  await f.getByRole('button', { name: /Publish and seal/ }).click()
  await f.getByRole('button', { name: /Retry from the failed step/ }).waitFor({ timeout: 30000 })
  await shot('a11-compose-failed')

  S('composer: reload mid-run, progress resumes')
  const draftHash = await f.evaluate(() => location.hash)
  await f.evaluate(() => location.reload())
  await page.waitForTimeout(500)
  f = app()
  await f.waitForSelector('main#main', { timeout: 20000 })
  const afterReload = await f.evaluate(() => location.hash)
  if (afterReload !== draftHash) throw new Error(`route not restored after reload: ${afterReload} vs ${draftHash}`)
  const resume = f.getByRole('button', { name: /Retry from the failed step|Continue publishing/ }).first()
  await resume.waitFor({ timeout: 20000 })
  await shot('a12-compose-reloaded')

  S('composer: retry, then the manual DEX steps')
  await resume.click()
  await f.getByRole('button', { name: 'Mark done' }).first().waitFor({ timeout: 30000 })
  await shot('a13-compose-manual-steps')
  for (let i = 0; i < 4; i++) {
    const md = f.getByRole('button', { name: 'Mark done' }).first()
    if (!(await md.count())) break
    await md.click()
    await page.waitForTimeout(1200)
  }

  S('composer: sealed')
  await f.getByText('Sealed and published').waitFor({ timeout: 30000 })
  await page.waitForTimeout(800)
  await shot('a14-compose-sealed')

  S('browser back returns to the previous route')
  // The browser back button traverses the frame's history entries (same-document, so no page navigation).
  await app().evaluate(() => history.back())
  await page.waitForTimeout(800)
  const back = await app().evaluate(() => location.hash)
  if (!back.startsWith('#/claims/pine-0009')) throw new Error(`back went to ${back}`)
})

// ---------------------------------------------------------------------------
// Journey B: evidence → demo sign-in → account → dashboard redeem → policies, agents, risks
// ---------------------------------------------------------------------------
await journey('journey-b', async () => {
  S('claim page → submit evidence')
  let f = await open('/claims/pine-0009')
  await f.getByRole('heading', { name: /Reporter deposits never draw principal/, level: 1 }).waitFor()
  await clickLink('/claims/pine-0009/evidence', { within: '#main' })
  await waitRoute('/claims/pine-0009/evidence')
  await f.locator('#ev-title').waitFor()

  S('evidence: connect the demo wallet, fill and submit')
  // Connect first: the connect button re-renders in place as the submit button during the same click, so
  // connecting after filling submits immediately (the live Next app does the same; native activation behaviour).
  const cw = f.getByRole('main').getByRole('button', { name: /connect demo wallet/i }).first()
  if (await cw.count()) await cw.click()
  await page.waitForTimeout(300)
  await f.locator('#ev-title').fill('Arbitration allocation funds a reporter top-up after a timeout')
  await f.locator('#ev-summary').fill('Running the planner after a bridge **timeout** funds the reporter deposit from the arbitration allocation.')
  await f.locator('#ev-cmd').fill('pnpm vitest run test/reporter-funding.spec.ts -t timeout')
  await f.locator('#ev-exp').fill('Top-up skipped and reporter.underfunded emitted')
  await f.locator('#ev-act').fill('Top-up of 40 sDAI drawn from the arbitration allocation')
  for (const cb of await f.locator('fieldset input[type="checkbox"]').all()) await cb.check()
  await page.waitForTimeout(300)
  await shot('b01-evidence-filled')
  const submit = f.getByRole('button', { name: /^Submit on/ })
  await submit.scrollIntoViewIfNeeded()
  await submit.click()
  await f.getByText(/Your evidence is on-chain/).waitFor({ timeout: 30000 })
  await page.waitForTimeout(500)
  await shot('b02-evidence-done')

  S('demo sign-in')
  if (mobile) {
    await mobileNav('/account')
  } else {
    await f.locator('header a[href="#/account"]').filter({ hasText: 'Sign in' }).click()
  }
  await waitRoute('/account')
  await f.getByRole('button', { name: /demo identity/i }).first().click()
  await f.getByRole('heading', { name: 'GitHub identity' }).waitFor({ timeout: 15000 })
  await shot('b03-account-signed-in')

  S('account: link the demo wallet, set a spending limit, export')
  const link = f.getByRole('button', { name: /link the connected wallet/i })
  if (await link.count()) await link.click()
  await f.getByText(/Demo wallet \(simulated signature\)|The connected wallet is linked/).first().waitFor({ timeout: 15000 })
  await f.locator('#pref-limit').fill('120')
  await f.locator('#pref-limit').press('Enter')
  await f.getByText(/Default spending limit saved/).waitFor({ timeout: 10000 })
  await f.getByRole('button', { name: /Export as JSON/ }).click()
  await f.getByText(/Account export/).first().waitFor({ timeout: 10000 })
  await page.waitForTimeout(400)
  await shot('b04-account-journey')

  S('session survives a reload')
  await f.evaluate(() => location.reload())
  await page.waitForTimeout(600)
  f = app()
  await f.getByRole('heading', { name: 'GitHub identity' }).waitFor({ timeout: 15000 })

  S('dashboard → redeem')
  await f.evaluate(() => window.scrollTo(0, 0))
  if (mobile) {
    await mobileNav('/dashboard')
  } else {
    await f.getByRole('button', { name: /Account menu for/ }).click()
    await f.getByRole('menuitem', { name: 'Dashboard' }).click()
  }
  await waitRoute('/dashboard')
  await page.waitForTimeout(800)
  await shot('b05-dashboard')
  const redeemLink = f.locator('#main a', { hasText: /^Redeem$/ }).first()
  await redeemLink.scrollIntoViewIfNeeded()
  await redeemLink.click()
  await waitRoute('/claims/')
  const redeem = f.getByRole('button', { name: /^Redeem$/ })
  await redeem.waitFor({ timeout: 15000 })
  await redeem.scrollIntoViewIfNeeded()
  await redeem.click()
  await f.getByText(/^Redeemed/).first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(500)
  await shot('b06-redeemed')

  S('policies → BOT-001')
  await f.evaluate(() => window.scrollTo(0, 0))
  if (mobile) {
    await mobileNav('/policies')
  } else await clickLink('/policies', { within: 'header' })
  await waitRoute('/policies')
  await shot('b07-policies')
  await clickLink('/policies/BOT-001', { within: '#main' })
  await waitRoute('/policies/BOT-001')
  await f.getByRole('heading', { name: /BOT-001@/, level: 1 }).waitFor()
  await shot('b08-policy')

  S('agents → llms.txt served in the browser')
  await f.evaluate(() => window.scrollTo(0, 0))
  if (mobile) {
    await mobileNav('/agents')
  } else await clickLink('/agents', { within: 'header' })
  await waitRoute('/agents')
  await f.getByText('A real brief: PINE-0009').waitFor({ timeout: 15000 })
  await shot('b09-agents')
  await f.locator('#main a[href="/llms.txt"]').click()
  await waitRoute('/llms.txt')
  await f.getByText(/Pine Prism/).first().waitFor()
  await f.locator('pre').first().waitFor()
  await shot('b10-llms-txt')
  await f.evaluate(() => history.back())
  await waitRoute('/agents')
  await f.locator('#main a[href="/api/agent/v1/claims?status=open"]').click()
  await waitRoute('/api/agent/v1/claims')
  await f.getByText(/"items"/).first().waitFor()

  S('risks → launch gates anchor')
  await f.evaluate(() => window.scrollTo(0, 0))
  await f.locator('footer a[href="#/risks"]').click()
  await waitRoute('/risks')
  await f.locator('a[href="#gates"]').click()
  await page.waitForTimeout(900)
  const gatesTop = await f.evaluate(() => document.getElementById('gates')?.getBoundingClientRect().top ?? 9999)
  if (gatesTop > 300 || gatesTop < -50) throw new Error(`launch gates not scrolled into view (top ${gatesTop})`)
  const hashAfter = await f.evaluate(() => location.hash)
  if (hashAfter !== '#/risks') throw new Error(`in-page anchor changed the route hash to ${hashAfter}`)
  await shot('b11-risks-gates')

  S('activity, drafts, repos')
  await f.locator('footer a[href="#/activity"]').click()
  await waitRoute('/activity')
  await shot('b12-activity')
  await f.locator('footer a[href="#/drafts"]').click()
  await waitRoute('/drafts')
  await f.locator('footer a[href="#/repos"]').click()
  await waitRoute('/repos')
  await shot('b13-repos')

  S('sign out')
  await f.evaluate(() => window.scrollTo(0, 0))
  await f.locator('footer a[href="#/account"]').click()
  await waitRoute('/account')
  await f.getByRole('button', { name: /^Sign out$/ }).click()
  await f.getByRole('button', { name: /demo identity/i }).first().waitFor({ timeout: 15000 })
})

// ---------------------------------------------------------------------------
// Deep links: every claim state and the remaining routes, opened from the initial #route
// ---------------------------------------------------------------------------
const ROUTES = [
  ['claim-settled', '/claims/pine-0001'],
  ['claim-yes', '/claims/pine-0002'],
  ['claim-no', '/claims/pine-0003'],
  ['claim-invalid', '/claims/pine-0004'],
  ['claim-arbitration', '/claims/pine-0005#oracle'],
  ['claim-disputed', '/claims/pine-0006'],
  ['claim-proposed', '/claims/pine-0007'],
  ['claim-awaiting', '/claims/pine-0008'],
  ['claim-hostile', '/claims/pine-0010#evidence'],
  ['claim-publishing', '/claims/pine-0015'],
  ['claim-failed', '/claims/pine-0016'],
  ['claim-missing', '/claims/pine-9999'],
  ['table-list', '/claims?view=list'],
  ['repo', '/repos/kleros/gateway-balancer-bot?pr=47'],
  ['repo-private', '/repos/mara-okafor/ops-runbooks'],
  ['policy-gated', '/policies/SC-001'],
  ['policy-missing', '/policies/NOPE-001'],
  ['launch-gates-redirect', '/launch-gates'],
  ['well-known', '/.well-known/pine.json'],
  ['not-found', '/no-such-page'],
]
await journey('routes', async () => {
  for (const [name, route] of ROUTES) {
    S(`deep link ${route}`)
    const f = await open(route)
    await page.waitForTimeout(1600)
    const title = await f.title()
    if (/^Pine Prism: hold/.test(title) && route !== '/') log(`    (default title on ${route})`)
    await shot(`r-${name}`)
  }
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const hosts = [...new Set(record.requests.map((u) => new URL(u).host))]
const report = {
  viewport: mobile ? '390x844' : '1440x900',
  journeys: results,
  requests: record.requests.length,
  hosts,
  externalRequests: record.external,
  failedRequests: record.failed,
  httpErrors: record.httpErrors,
  consoleErrors: record.console,
  pageErrors: record.pageErrors,
  server404s: serverLog.filter((e) => e.status >= 400),
  heroColdFallbacks: record.heroColdFallbacks,
}
await writeFile(join(OUT, `verify-${tag}.json`), JSON.stringify(report, null, 2))
log(`\nviewport ${report.viewport}: ${results.filter((r) => r.ok).length}/${results.length} journeys passed`)
log(`requests ${report.requests}, hosts ${hosts.join(', ')}; hero cold-start fallbacks ${record.heroColdFallbacks}`)
log(`external ${record.external.length}, failed ${record.failed.length}, http errors ${record.httpErrors.length}, console errors ${record.console.length}, page errors ${record.pageErrors.length}`)
for (const k of ['external', 'failed', 'httpErrors', 'console', 'pageErrors']) for (const e of record[k].slice(0, 8)) log(`  ${k}: ${JSON.stringify(e)}`)
await browser.close()
server.close()
process.exit(results.every((r) => r.ok) && errCount() === 0 ? 0 : 1)
