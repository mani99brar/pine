// Screenshot QA for Pine Docket.
// Usage: node qa/screens.mjs [filter...]   (filters match shot names; default: all)
// Env: BASE_URL (default http://localhost:3002)
import { chromium } from '@playwright/test'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.qa')
const filters = process.argv.slice(2)

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]

/** Route shots. `full` captures the whole page; `act` runs before the shot. */
const SHOTS = [
  { name: 'landing', url: '/' },
  { name: 'docket', url: '/docket' },
  { name: 'docket-list', url: '/docket?view=list&sort=newest' },
  { name: 'docket-empty', url: '/docket?q=zzzz-nothing' },
  { name: 'claim-open', url: '/claims/pine-0009' },
  { name: 'claim-hostile', url: '/claims/pine-0010' },
  { name: 'claim-publishing', url: '/claims/pine-0015' },
  { name: 'claim-failed', url: '/claims/pine-0016' },
  { name: 'claim-arbitration', url: '/claims/pine-0005' },
  { name: 'claim-disputed', url: '/claims/pine-0006' },
  { name: 'claim-missing', url: '/claims/pine-9999' },
  { name: 'evidence', url: '/claims/pine-0009/evidence' },
  { name: 'file-start', url: '/file' },
  { name: 'filings', url: '/filings' },
  { name: 'my-docket', url: '/my-docket' },
  { name: 'account', url: '/account' },
  { name: 'repositories', url: '/repositories' },
  { name: 'repo', url: '/repositories/kleros/gateway-balancer-bot' },
  { name: 'pull', url: '/repositories/kleros/gateway-balancer-bot/pull/47' },
  { name: 'policies', url: '/policies' },
  { name: 'policy-bot', url: '/policies/BOT-001' },
  { name: 'policy-sc', url: '/policies/SC-001' },
  { name: 'activity', url: '/activity' },
  { name: 'agents', url: '/agents' },
  { name: 'risks', url: '/risks' },
  { name: 'how', url: '/how-it-works' },
  { name: '404', url: '/no-such-page' },
]

const WIZARD_STEPS = ['source', 'policy', 'claim', 'environment', 'deadlines', 'funding', 'review', 'publish']

/** Use the bundled browser when present; otherwise fall back to any Chromium already in the Playwright cache. */
function launchOptions() {
  try {
    if (existsSync(chromium.executablePath())) return {}
  } catch {
    /* fall through */
  }
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
  const linuxCache = path.join(os.homedir(), '.cache', 'ms-playwright')
  for (const dir of [cache, linuxCache]) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir).sort().reverse()) {
      const candidates = [
        path.join(dir, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
        path.join(dir, entry, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(dir, entry, 'chrome-linux', 'chrome'),
        path.join(dir, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
      ]
      const found = candidates.find((c) => existsSync(c))
      if (found) return { executablePath: found }
    }
  }
  return {}
}

function wanted(name) {
  return filters.length === 0 || filters.some((f) => name.includes(f))
}

async function checkOverflow(page, name, errors) {
  const overflow = await page.evaluate(() => {
    const w = document.documentElement.clientWidth
    const wide = [...document.querySelectorAll('body *')].filter((el) => {
      const r = el.getBoundingClientRect()
      return r.right > w + 1 && getComputedStyle(el).position !== 'fixed' && r.width > 0
    })
    return { scroll: document.documentElement.scrollWidth > w, offenders: wide.slice(0, 3).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`) }
  })
  if (overflow.scroll) errors.push(`${name}: horizontal overflow ${overflow.offenders.join(' | ')}`)
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(700)
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch(launchOptions())
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${page.url()}: console: ${m.text().slice(0, 300)}`)
    })

    // Connect the simulated wallet and sign in (demo) once per context for signed-in views.
    await page.goto(`${BASE}/?qa=1`, { waitUntil: "domcontentloaded" })
    await settle(page)

    for (const s of SHOTS) {
      const name = `${s.name}-${vp.name}`
      if (!wanted(name)) continue
      await page.goto(`${BASE}${s.url}`, { waitUntil: 'domcontentloaded' })
      await settle(page)
      if (s.act) await s.act(page)
      await checkOverflow(page, name, errors)
      await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true })
      console.log('shot', name)
    }

    // Signed-in + wallet views
    if (wanted(`signedin-${vp.name}`) || filters.some((f) => 'signedin'.includes(f))) {
      await page.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' })
      await settle(page)
      const signIn = page.getByRole('button', { name: /sign in/i }).first()
      if (await signIn.isVisible().catch(() => false)) {
        await signIn.click()
        await page.waitForTimeout(2500)
        await settle(page)
      }
      const connect = page.getByRole('button', { name: /connect (simulated )?wallet/i }).first()
      if (await connect.isVisible().catch(() => false)) {
        await connect.click()
        await page.waitForTimeout(800)
      }
      for (const u of [
        ['account-signedin', '/account'],
        ['my-docket-signedin', '/my-docket'],
        ['activity-signedin', '/activity'],
        ['claim-resolved-signedin', '/claims/pine-0001'],
      ]) {
        await page.goto(`${BASE}${u[1]}`, { waitUntil: 'domcontentloaded' })
        await settle(page)
        await checkOverflow(page, u[0], errors)
        await page.screenshot({ path: path.join(OUT, `${u[0]}-${vp.name}.png`), fullPage: true })
        console.log('shot', `${u[0]}-${vp.name}`)
      }
    }

    // Wizard: start from the worked example, then visit each step.
    if (WIZARD_STEPS.some((st) => wanted(`wizard-${st}-${vp.name}`))) {
      await page.goto(`${BASE}/file`, { waitUntil: 'domcontentloaded' })
      await settle(page)
      await page.getByRole('button', { name: /worked example/i }).click()
      await page.waitForURL(/\/file\/[^/?]+/, { timeout: 20000 })
      await settle(page)
      // Pin the PR head commit in the source step
      const pinBtn = page.getByRole('button', { name: /^pin this commit$/i }).first()
      await pinBtn.waitFor({ timeout: 15000 }).catch(() => {})
      if (await pinBtn.isVisible().catch(() => false)) {
        await pinBtn.click()
        await page.waitForTimeout(900)
      }
      const draftUrl = page.url().split('?')[0]
      for (const st of WIZARD_STEPS) {
        const name = `wizard-${st}-${vp.name}`
        await page.goto(`${draftUrl}?step=${st}`, { waitUntil: 'domcontentloaded' })
        await settle(page)
        if (st === 'review') {
          // tick acknowledgements for the publish shot
          const boxes = page.locator('input[id^="ack-"]')
          const n = await boxes.count()
          for (let i = 0; i < n; i++) await boxes.nth(i).check().catch(() => {})
        }
        if (wanted(name)) {
          await checkOverflow(page, name, errors)
          await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true })
          console.log('shot', name)
        }
      }
      if (vp.name === 'mobile' && wanted('wizard-mobile-steps')) {
        await page.goto(`${draftUrl}?step=claim`, { waitUntil: 'domcontentloaded' })
        await settle(page)
        await page.locator('details summary', { hasText: /all steps/i }).first().click().catch(() => {})
        await page.locator('details summary', { hasText: /what does this mean/i }).first().click().catch(() => {})
        await page.waitForTimeout(300)
        await page.screenshot({ path: path.join(OUT, `wizard-mobile-steps.png`), fullPage: false })
        console.log('shot wizard-mobile-steps')
      }
    }

    // Mobile nav open
    if (vp.name === 'mobile' && wanted('nav-open')) {
      await page.goto(`${BASE}/docket`, { waitUntil: 'domcontentloaded' })
      await settle(page)
      await page.getByRole('button', { name: /open menu/i }).click()
      await page.waitForTimeout(500)
      await page.screenshot({ path: path.join(OUT, `nav-open-mobile.png`) })
      console.log('shot nav-open-mobile')
    }

    // Print emulation of a claim
    if (vp.name === 'desktop' && wanted('print')) {
      await page.emulateMedia({ media: 'print' })
      await page.goto(`${BASE}/claims/pine-0009`, { waitUntil: 'domcontentloaded' })
      await settle(page)
      await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)))
      await page.setViewportSize({ width: 820, height: 1160 })
      await page.screenshot({ path: path.join(OUT, `print-claim.png`), fullPage: true })
      await page.pdf({ path: path.join(OUT, `print-claim.pdf`), format: 'A4', printBackground: true }).catch(() => {})
      await page.emulateMedia({ media: 'screen' })
      await page.setViewportSize({ width: vp.width, height: vp.height })
      console.log('shot print-claim')
    }

    if (errors.length) {
      console.log(`\n${vp.name}: ${errors.length} page errors`)
      for (const e of [...new Set(errors)].slice(0, 40)) console.log('  -', e)
    }
    await ctx.close()
  }
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
