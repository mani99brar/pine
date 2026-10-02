// Screenshot QA for Pine Console.
// Usage: node qa/screens.mjs [filter] [--base=http://localhost:3001] [--only=desktop|mobile] [--dark]
// Saves PNGs to apps/console/.qa/<viewport>/<name>.png
import { chromium } from '@playwright/test'
import { mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(here, '../.qa')
const args = process.argv.slice(2)
const filterArg = args.find((a) => !a.startsWith('--'))
const filters = filterArg ? filterArg.split(',') : null
const base = (args.find((a) => a.startsWith('--base='))?.slice(7) ?? 'http://localhost:3001').replace(/\/$/, '')
const only = args.find((a) => a.startsWith('--only='))?.slice(7)
const darkOnly = args.includes('--dark')

const PR = 'https://github.com/kleros/gateway-balancer-bot/pull/52'

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, isMobile: false },
  { name: 'mobile', width: 390, height: 844, isMobile: true },
]

async function settle(page, ms = 900) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 })
  } catch {
    /* polling pages never go idle */
  }
  await page.waitForTimeout(ms)
}

async function dismissBanner(page) {
  // Keep the demo banner visible on the landing shot only.
}


const DRAFT = '/new?draft=draft-bkt41q&qa=1'

async function preparePublish(page) {
  await page.waitForSelector('#sec-review', { timeout: 20000 })
  const connect = page.getByRole('button', { name: /Connect (demo )?wallet|Connect wallet to publish/ }).first()
  if (await connect.isVisible().catch(() => false)) await connect.click()
  await page.waitForTimeout(400)
  await page.evaluate(() => document.getElementById('sec-review')?.scrollIntoView({ block: 'start' }))
  await page.locator('#ack').check()
  await page.waitForTimeout(300)
}

const PUBLISH_SHOTS = [
  {
    name: 'composer-publish-manual',
    path: DRAFT,
    fullPage: false,
    action: async (page) => {
      await preparePublish(page)
      await page.getByRole('button', { name: 'Publish claim and create market' }).click()
      await page.waitForSelector('text=Mark done', { timeout: 30000 })
      await page.evaluate(() => document.querySelector('[aria-live="polite"] ol')?.scrollIntoView({ block: 'center' }))
      await page.waitForTimeout(300)
    },
  },
  {
    name: 'composer-publish-done',
    path: DRAFT,
    fullPage: false,
    action: async (page) => {
      await preparePublish(page)
      await page.getByRole('button', { name: 'Publish claim and create market' }).click()
      for (let i = 0; i < 2; i++) {
        const done = page.getByRole('button', { name: 'Mark done' }).first()
        await done.waitFor({ timeout: 30000 }).catch(() => {})
        if (await done.isVisible().catch(() => false)) await done.click()
        await page.waitForTimeout(800)
      }
      await page.waitForSelector('text=All steps confirmed', { timeout: 30000 }).catch(() => {})
      await page.evaluate(() => document.getElementById('sec-review')?.scrollIntoView({ block: 'end' }))
      await page.waitForTimeout(400)
    },
  },
  {
    name: 'composer-publish-failed',
    path: DRAFT,
    fullPage: false,
    action: async (page) => {
      await preparePublish(page)
      const arm = page.getByRole('button', { name: /Simulate failure on next transaction/ }).first()
      if (await arm.isVisible().catch(() => false)) await arm.click()
      await page.evaluate(() => document.getElementById('sec-review')?.scrollIntoView({ block: 'start' }))
      await page.getByRole('button', { name: 'Publish claim and create market' }).click()
      await page.waitForSelector('text=Retry step', { timeout: 30000 })
      await page.evaluate(() => document.querySelector('[aria-live="polite"] ol')?.scrollIntoView({ block: 'center' }))
      await page.waitForTimeout(300)
    },
  },
]

/** Each shot: name, path, optional action(page, vp) run before the screenshot, fullPage default true. */
const SHOTS = [
  { name: 'landing', path: '/' },
  { name: 'claims', path: '/claims' },
  { name: 'claims-open-view', path: '/claims?view=open&sort=yes&dir=desc' },
  { name: 'claims-empty-filter', path: '/claims?q=zzzz-no-match' },
  { name: 'claim-open-keeper', path: '/claims/pine-0009' },
  { name: 'claim-open-market', path: '/claims/pine-0009?tab=market' },
  { name: 'claim-open-agent', path: '/claims/pine-0009?tab=agent' },
  { name: 'claim-hostile-evidence', path: '/claims/pine-0010?tab=evidence' },
  { name: 'claim-awaiting-answer', path: '/claims/pine-0008' },
  { name: 'claim-answer-proposed-oracle', path: '/claims/pine-0007?tab=oracle' },
  { name: 'claim-disputed', path: '/claims/pine-0006?tab=oracle' },
  { name: 'claim-arbitration', path: '/claims/pine-0005' },
  { name: 'claim-resolved-yes', path: '/claims/pine-0002' },
  { name: 'claim-resolved-no', path: '/claims/pine-0003' },
  { name: 'claim-resolved-invalid', path: '/claims/pine-0004' },
  { name: 'claim-settled', path: '/claims/pine-0001?tab=activity' },
  { name: 'claim-publishing-recover', path: '/claims/pine-0015' },
  { name: 'claim-failed', path: '/claims/pine-0016' },
  { name: 'claim-not-found', path: '/claims/pine-9999' },
  { name: 'composer-empty', path: '/new', fullPage: false },
  {
    name: 'composer-from-pr',
    path: `/new?source=${encodeURIComponent(PR)}`,
    fullPage: false,
    action: async (page) => {
      await page.waitForSelector('text=Pinned commit', { timeout: 15000 })
      await page.locator('input[name="policy"][value="BOT-001"]').check()
      await page.fill('#f-spec-title', 'Recovery never re-bridges an operation after a journaled bridge receipt')
      await page.fill('#f-spec-requirement', 'After a crash between a journaled bridge receipt and destination swap settlement, recovery resumes the swap leg for the same operation id and never plans a second bridge for it.')
      await page.fill('#f-spec-violation', 'recovery plans a second bridge transfer for an operation whose bridge receipt is already journaled')
      await page.waitForTimeout(900)
    },
  },
  {
    name: 'composer-claim-section',
    path: `/new?source=${encodeURIComponent(PR)}`,
    fullPage: false,
    action: async (page) => {
      await page.waitForSelector('text=Pinned commit', { timeout: 15000 })
      await page.locator('input[name="policy"][value="BOT-001"]').check()
      await page.fill('#f-spec-violation', 'recovery plans a second bridge transfer for an operation whose bridge receipt is already journaled')
      await page.locator('#sec-claim').scrollIntoViewIfNeeded()
      await page.evaluate(() => document.getElementById('sec-claim')?.scrollIntoView({ block: 'start' }))
      await page.waitForTimeout(600)
      await page.fill('#f-spec-violation', 'recovery plans a second bridge transfer for an already-bridged operation')
      await page.waitForTimeout(250)
    },
  },
  {
    name: 'composer-funding',
    path: `/new?source=${encodeURIComponent(PR)}`,
    fullPage: false,
    action: async (page) => {
      await page.waitForSelector('text=Pinned commit', { timeout: 15000 })
      await page.evaluate(() => document.getElementById('sec-funding')?.scrollIntoView({ block: 'start' }))
      await page.waitForTimeout(700)
    },
  },
  {
    name: 'composer-deadlines',
    path: `/new?source=${encodeURIComponent(PR)}`,
    fullPage: false,
    action: async (page) => {
      await page.waitForSelector('text=Pinned commit', { timeout: 15000 })
      await page.evaluate(() => document.getElementById('sec-deadlines')?.scrollIntoView({ block: 'start' }))
      await page.waitForTimeout(700)
    },
  },
  {
    name: 'composer-review',
    path: `/new?source=${encodeURIComponent(PR)}`,
    fullPage: false,
    action: async (page) => {
      await page.waitForSelector('text=Pinned commit', { timeout: 15000 })
      await page.evaluate(() => document.getElementById('sec-review')?.scrollIntoView({ block: 'start' }))
      await page.waitForTimeout(700)
    },
  },
  {
    name: 'palette-paste-url',
    path: '/claims',
    fullPage: false,
    action: async (page, vp) => {
      if (vp.isMobile) await page.getByRole('button', { name: 'Open command palette' }).last().click()
      else await page.keyboard.press('Control+k')
      await page.waitForSelector('[cmdk-input]')
      await page.fill('[cmdk-input]', PR)
      await page.waitForTimeout(1500)
    },
  },
  {
    name: 'palette-open',
    path: '/claims/pine-0009',
    fullPage: false,
    action: async (page, vp) => {
      if (vp.isMobile) await page.getByRole('button', { name: 'Open command palette' }).last().click()
      else await page.keyboard.press('Control+k')
      await page.waitForSelector('[cmdk-input]')
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'shortcuts-sheet',
    path: '/dashboard',
    fullPage: false,
    viewports: ['desktop'],
    action: async (page) => {
      await page.keyboard.press('Shift+Slash')
      await page.waitForTimeout(500)
    },
  },
  {
    name: 'mobile-nav-open',
    path: '/dashboard',
    fullPage: false,
    viewports: ['mobile'],
    action: async (page) => {
      await page.getByRole('button', { name: 'More' }).click()
      await page.waitForTimeout(500)
    },
  },
  { name: 'drafts', path: '/drafts' },
  { name: 'dashboard', path: '/dashboard' },
  {
    name: 'dashboard-connected',
    path: '/dashboard',
    action: async (page) => {
      const btn = page.getByRole('button', { name: /Connect (demo )?wallet/ }).first()
      if (await btn.isVisible().catch(() => false)) await btn.click()
      await page.waitForTimeout(1200)
    },
  },
  { name: 'settings', path: '/settings' },
  {
    name: 'settings-signed-in',
    path: '/settings',
    action: async (page) => {
      const btn = page.getByRole('button', { name: /Use the demo GitHub identity|Sign in with GitHub/ }).first()
      if (await btn.isVisible().catch(() => false)) await btn.click()
      await page.waitForSelector('text=Sign out', { timeout: 20000 }).catch(() => {})
      const connect = page.getByRole('button', { name: /Connect (demo )?wallet/ }).first()
      if (await connect.isVisible().catch(() => false)) await connect.click()
      await page.waitForTimeout(600)
      const link = page.getByRole('button', { name: /^Link 0x|Connect and link a wallet/ }).first()
      if (await link.isVisible().catch(() => false)) await link.click()
      await page.waitForTimeout(1500)
    },
  },
  { name: 'repos', path: '/repos' },
  { name: 'repo-detail', path: '/repos/kleros/gateway-balancer-bot' },
  { name: 'repo-pull', path: '/repos/kleros/gateway-balancer-bot/pull/47' },
  { name: 'evidence-new', path: '/claims/pine-0009/evidence/new' },
  { name: 'policies', path: '/policies' },
  { name: 'policy-bot', path: '/policies/BOT-001' },
  { name: 'policy-sc-gated', path: '/policies/SC-001' },
  { name: 'activity', path: '/activity' },
  { name: 'agents', path: '/agents' },
  { name: 'risks', path: '/risks' },
  { name: 'not-found', path: '/definitely-not-a-route' },
  ...PUBLISH_SHOTS,
]

/** Uses Playwright's expected browser, or falls back to any installed headless-shell revision. */
async function launch() {
  try {
    return await chromium.launch()
  } catch (e) {
    const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
    const dirs = existsSync(cache) ? (await readdir(cache)).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : []
    for (const d of dirs) {
      const exe = path.join(cache, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
      if (existsSync(exe)) return chromium.launch({ executablePath: exe })
    }
    throw e
  }
}

async function run() {
  const browser = await launch()
  const schemes = darkOnly ? ['dark'] : ['light']
  for (const scheme of schemes) {
    for (const vp of VIEWPORTS) {
      if (only && vp.name !== only) continue
      const dir = path.join(outDir, scheme === 'dark' ? `${vp.name}-dark` : vp.name)
      await mkdir(dir, { recursive: true })
      for (const shot of SHOTS) {
        if (filters && !filters.some((f) => shot.name.includes(f))) continue
        if (shot.viewports && !shot.viewports.includes(vp.name)) continue
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          isMobile: vp.isMobile,
          hasTouch: vp.isMobile,
          deviceScaleFactor: 1,
          colorScheme: scheme,
          reducedMotion: 'reduce',
        })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', (e) => errors.push(e.message))
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(m.text())
        })
        try {
          await page.goto(base + shot.path, { waitUntil: 'domcontentloaded', timeout: 60000 })
          await settle(page)
          if (shot.action) await shot.action(page, vp)
          const file = path.join(dir, `${shot.name}.png`)
          const full = shot.fullPage !== false
          if (full) {
            const h = await page.evaluate(() => document.documentElement.scrollHeight)
            await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, width: vp.width, height: Math.min(h, vp.isMobile ? 1900 : 2600) } })
          } else {
            await page.screenshot({ path: file })
          }
          const overflow = await page.evaluate((w) => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - w, vp.width)
          if (overflow > 1) errors.push(`HORIZONTAL OVERFLOW ${overflow}px`)
          const errs = errors.filter((e) => !/Download the React DevTools|favicon|WalletConnect|Lit is in dev mode|reown|web3modal/i.test(e))
          console.log(`${vp.name}${scheme === 'dark' ? '-dark' : ''} ${shot.name} ok${errs.length ? `  [${errs.length} console errors: ${errs.slice(0, 2).join(' | ').slice(0, 300)}]` : ''}`)
        } catch (e) {
          console.log(`${vp.name} ${shot.name} FAILED: ${e.message.split('\n')[0]}`)
        }
        await context.close()
      }
    }
  }
  await browser.close()
}

run()
