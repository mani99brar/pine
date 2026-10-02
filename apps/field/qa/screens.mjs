// Screenshot QA for Pine Field.
// Usage: node qa/screens.mjs [baseUrl] [filter]
// Saves PNGs to apps/field/.qa/<name>-<viewport>.png at 1440x900 and 390x844.
import { chromium } from '@playwright/test'
import { mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', '.qa')
const base = process.argv[2] ?? 'http://localhost:3003'
const filter = process.argv[3]

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]

/** Each entry: name, path, optional setup(page) run after load, fullPage flag. */
const ROUTES = [
  { name: 'landing', path: '/' },
  { name: 'board', path: '/board' },
  { name: 'board-list', path: '/board?view=list' },
  { name: 'board-map', path: '/board?view=map' },
  { name: 'board-all', path: '/board?status=all&sort=move' },
  { name: 'board-empty', path: '/board?q=zzzz-no-match' },
  { name: 'claim-open', path: '/claims/pine-0009' },
  { name: 'claim-hostile', path: '/claims/pine-0010', setup: async (p) => clickTab(p, 'Evidence') },
  { name: 'claim-awaiting', path: '/claims/pine-0008' },
  { name: 'claim-proposed', path: '/claims/pine-0007', setup: async (p) => clickTab(p, 'Oracle and dispute') },
  { name: 'claim-disputed', path: '/claims/pine-0006', setup: async (p) => clickTab(p, 'Oracle and dispute') },
  { name: 'claim-arbitration', path: '/claims/pine-0005', setup: async (p) => clickTab(p, 'Oracle and dispute') },
  { name: 'claim-resolved-yes', path: '/claims/pine-0002' },
  { name: 'claim-resolved-no', path: '/claims/pine-0003' },
  { name: 'claim-invalid', path: '/claims/pine-0004' },
  { name: 'claim-settled', path: '/claims/pine-0001' },
  { name: 'claim-publishing', path: '/claims/pine-0015' },
  { name: 'claim-failed', path: '/claims/pine-0016' },
  { name: 'claim-missing', path: '/claims/pine-9999' },
  { name: 'compose-source', path: '/compose' },
  { name: 'compose-pinned', path: '/compose', setup: async (p) => composeTo(p, 'source-pinned') },
  { name: 'compose-policy', path: '/compose', setup: async (p) => composeTo(p, 'policy') },
  { name: 'compose-claim', path: '/compose', setup: async (p) => composeTo(p, 'claim') },
  { name: 'compose-deadlines', path: '/compose', setup: async (p) => composeTo(p, 'deadlines') },
  { name: 'compose-funding', path: '/compose', setup: async (p) => composeTo(p, 'funding') },
  { name: 'compose-review', path: '/compose', setup: async (p) => composeTo(p, 'review') },
  { name: 'compose-from', path: '/compose?from=pine-0016' },
  { name: 'compose-publish', path: '/compose?from=pine-0016', setup: async (p) => toPublish(p, false) },
  { name: 'compose-published', path: '/compose?from=pine-0016', setup: async (p) => toPublish(p, true) },
  { name: 'drafts', path: '/drafts' },
  { name: 'dashboard', path: '/dashboard', setup: connectWallet },
  { name: 'dashboard-signedout', path: '/dashboard' },
  { name: 'account', path: '/account' },
  {
    name: 'account-signedin',
    path: '/account',
    setup: async (p) => {
      const b = p.getByRole('button', { name: /demo identity/ }).first()
      if (await b.count()) await b.click()
      await p.getByRole('heading', { name: 'Account and settings' }).waitFor({ timeout: 20000 })
      await p.waitForTimeout(800)
    },
  },
  { name: 'repos', path: '/repos' },
  { name: 'repo-detail', path: '/repos/kleros/gateway-balancer-bot' },
  { name: 'evidence-submit', path: '/claims/pine-0009/evidence' },
  { name: 'policies', path: '/policies' },
  { name: 'policy-detail', path: '/policies/BOT-001' },
  { name: 'policy-gated', path: '/policies/SC-001' },
  { name: 'activity', path: '/activity', setup: connectWallet },
  { name: 'agents', path: '/agents' },
  { name: 'risks', path: '/risks' },
  { name: 'not-found', path: '/this-route-does-not-exist' },
  { name: 'mobile-nav', path: '/board', mobileOnly: true, setup: async (p) => p.getByRole('button', { name: 'Open menu' }).click() },
]

async function clickTab(page, name) {
  const tab = page.getByRole('tab', { name: new RegExp(`^${name}`) })
  if (await tab.count()) await tab.first().click()
  await page.waitForTimeout(400)
}

async function connectWallet(page) {
  const btn = page.getByRole('button', { name: /Connect demo wallet/ }).first()
  if (await btn.count()) {
    if (await btn.isVisible()) await btn.click()
  }
  await page.waitForTimeout(900)
}

async function toPublish(page, run) {
  await page.getByRole('button', { name: /Review/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByRole('checkbox').first().check()
  await page.getByRole('button', { name: 'Continue to publish' }).first().click()
  await page.waitForTimeout(500)
  if (!run) return
  await connectWallet(page)
  await page.getByRole('button', { name: /^Publish$|Continue publishing/ }).first().click()
  // Simulated steps take a few seconds each; wait for the manual liquidity step.
  await page.getByRole('button', { name: 'Mark done' }).first().waitFor({ timeout: 60000 })
}

async function composeTo(page, stage) {
  // Paste a demo PR and pin it, then walk forward through stages.
  const input = page.locator('#source-input')
  await input.waitFor({ timeout: 15000 })
  await input.fill('kleros/gateway-balancer-bot#52')
  await page.getByRole('button', { name: 'Pin this commit' }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: 'Pin this commit' }).click()
  await page.waitForTimeout(1300)
  if (stage === 'source-pinned') return
  await page.getByRole('button', { name: 'Continue to policy' }).first().click()
  await page.waitForTimeout(300)
  await page.getByRole('radio', { name: /BOT-001/ }).first().click()
  if (stage === 'policy') return
  const go = async (label) => {
    await page.getByRole('button', { name: label }).first().click()
    await page.waitForTimeout(500)
  }
  await go('Continue to claim')
  if (stage === 'claim') return
  await go('Continue to deadlines')
  if (stage === 'deadlines') return
  await go('Continue to funding')
  if (stage === 'funding') return
  await go('Continue to review')
  if (stage === 'review') return
  await go('Continue to publish')
}

await mkdir(out, { recursive: true })
/** Launch Chromium; fall back to any installed headless shell when the pinned build is missing. */
async function launch() {
  try {
    return await chromium.launch()
  } catch (e) {
    const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), 'Library', 'Caches', 'ms-playwright')
    const dirs = existsSync(cache) ? (await readdir(cache)).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : []
    for (const d of dirs) {
      for (const sub of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-linux64']) {
        const exe = join(cache, d, sub, 'chrome-headless-shell')
        if (existsSync(exe)) return chromium.launch({ executablePath: exe })
      }
    }
    throw e
  }
}
const browser = await launch()
const failures = []
for (const vp of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
  for (const r of ROUTES) {
    if (filter && !r.name.includes(filter)) continue
    if (r.mobileOnly && vp.name !== 'mobile') continue
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    try {
      const res = await page.goto(base + r.path + (r.path.includes('?') ? '&' : '?') + 'qa=1', { waitUntil: 'networkidle', timeout: 45000 })
      await page.waitForTimeout(1200)
      // Sticky chrome repeats inside full-page clips; pin it in place for screenshots.
      await page.addStyleTag({ content: '.sticky,[class*="sticky"]{position:static!important}' })
      if (r.setup) await r.setup(page)
      await page.waitForTimeout(600)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      if (overflow > 1) errors.push(`horizontal overflow ${overflow}px`)
      // Save the page in readable chunks (desktop 1800px, mobile 1500px tall).
      const total = await page.evaluate(() => document.documentElement.scrollHeight)
      const chunk = vp.name === 'desktop' ? 1800 : 1500
      const n = r.fullPage === false ? 1 : Math.min(8, Math.ceil(total / chunk))
      for (let i = 0; i < n; i++) {
        const y = i * chunk
        const h = Math.min(chunk, total - y)
        if (h <= 40) break
        await page.screenshot({ path: join(out, `${r.name}-${vp.name}-${i + 1}.png`), fullPage: true, clip: { x: 0, y, width: vp.width, height: h } })
      }
      console.log(`${res?.status() ?? '???'} ${vp.name} ${r.name}${errors.length ? `  [${errors.length} console errors: ${errors[0].slice(0, 160)}]` : ''}`)
      if (errors.length) failures.push({ route: r.name, vp: vp.name, errors })
    } catch (e) {
      console.log(`ERR ${vp.name} ${r.name}: ${String(e).slice(0, 200)}`)
      failures.push({ route: r.name, vp: vp.name, errors: [String(e)] })
    }
    await page.close()
  }
  await context.close()
}
await browser.close()
if (failures.length) {
  console.log(`\n${failures.length} routes with errors`)
  for (const f of failures) console.log(`- ${f.vp} ${f.route}: ${f.errors.slice(0, 2).join(' | ').slice(0, 300)}`)
}
