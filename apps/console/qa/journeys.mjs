// Journey QA for Pine Console: walks the core flows as a first-time user and screenshots each step.
// Usage: node qa/journeys.mjs [journey,...] [--vp=desktop|mobile] [--dark] [--base=http://localhost:3001]
// Journeys: explore, account, compose, evidence, dashboard, states, pages, keyboard
// Output: .qa/journeys/<vp>[-dark]/<journey>-<nn>-<step>.png and a log of observations on stdout.
import { chromium } from '@playwright/test'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const flag = (k) => args.includes(`--${k}`)
const pick = args.find((a) => !a.startsWith('--'))?.split(',')
const base = (opt('base') ?? 'http://localhost:3001').replace(/\/$/, '')
const vpName = opt('vp') ?? 'desktop'
const dark = flag('dark')
const VP = vpName === 'mobile' ? { width: 390, height: 844, isMobile: true } : { width: 1440, height: 900, isMobile: false }
const outDir = path.resolve(here, '../.qa/journeys', `${vpName}${dark ? '-dark' : ''}`)

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

let problems = 0
function note(j, msg) {
  console.log(`  [${j}] ${msg}`)
}
function bad(j, msg) {
  problems++
  console.log(`  [${j}] ✗ ${msg}`)
}

async function settle(page, ms = 600) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 })
  } catch {}
  await page.waitForTimeout(ms)
}

function makeShot(page, j) {
  let n = 0
  return async (name, opts = {}) => {
    n++
    const file = path.join(outDir, `${j}-${String(n).padStart(2, '0')}-${name}.png`)
    await page.waitForTimeout(opts.wait ?? 250)
    await page.screenshot({ path: file, fullPage: !!opts.full })
    const overflow = await page.evaluate((w) => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - w, VP.width)
    if (overflow > 1) bad(j, `horizontal overflow ${overflow}px at ${name}`)
    return file
  }
}

async function openPalette(page) {
  if (VP.isMobile) await page.getByRole('button', { name: 'Open command palette' }).last().click()
  else await page.keyboard.press('Control+k')
  await page.waitForSelector('[cmdk-input]')
}

async function connectWallet(page) {
  const btn = page.getByRole('button', { name: /^(Connect (demo )?wallet|Connect wallet to publish|Connect the creator wallet)/ }).first()
  if (await btn.isVisible().catch(() => false)) {
    await btn.click()
    await page.waitForTimeout(500)
    return true
  }
  return false
}

const JOURNEYS = {
  async explore(page, j, shot) {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await shot('landing')
    // From landing to explore
    const all = page.getByRole('link', { name: 'All claims' }).first()
    if (await all.isVisible().catch(() => false)) await all.click()
    else await page.goto(base + '/claims')
    await settle(page)
    await shot('claims')
    if (!VP.isMobile) {
      await page.keyboard.press('j')
      await page.keyboard.press('j')
      await page.waitForTimeout(200)
      await shot('claims-jj')
    }
    await page.goto(base + '/claims?q=keeper', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await shot('claims-search-keeper')
    await page.goto(base + '/claims/pine-0009', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await shot('keeper-overview')
    for (const tab of ['Market', 'Evidence', 'Oracle', 'Agent', 'Activity']) {
      await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).first().click()
      await page.waitForTimeout(500)
      await shot(`keeper-${tab.toLowerCase()}`)
    }
    // copy agent brief
    await page.getByRole('button', { name: /Copy agent brief|Copy brief/ }).first().click().catch(() => bad(j, 'no copy brief button'))
    await page.waitForTimeout(300)
    await shot('keeper-copied')
  },

  async account(page, j, shot) {
    await page.goto(base + '/settings', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await shot('settings-signed-out')
    const signIn = page.getByRole('button', { name: /Use the demo GitHub identity/ }).first()
    await signIn.click()
    await page.waitForSelector('text=Sign out', { timeout: 20000 }).catch(() => bad(j, 'sign-in did not finish'))
    await settle(page)
    await shot('settings-signed-in')
    // Link wallet
    const linkBtn = page.getByRole('button', { name: /^Link 0x|Connect and link a wallet/ }).first()
    await linkBtn.click()
    await page.waitForTimeout(2500)
    await shot('settings-link-1')
    const linkAgain = page.getByRole('button', { name: /^Link 0x|Connect and link a wallet/ }).first()
    if (await linkAgain.isVisible().catch(() => false)) {
      note(j, `link button still visible after click: "${await linkAgain.innerText()}"`)
      await linkAgain.click()
      await page.waitForTimeout(2500)
    }
    await page.locator('#wallets').scrollIntoViewIfNeeded()
    await shot('settings-linked')
    // Spending limit
    const limit = page.locator('#pref-limit')
    if (await limit.isVisible().catch(() => false)) {
      await limit.fill('')
      await limit.type('75')
      await limit.press('Enter')
      await page.waitForTimeout(800)
      await shot('settings-limit-enter')
      await limit.blur()
      await page.waitForTimeout(800)
      await shot('settings-limit-saved')
      await limit.fill('abc')
      await limit.blur()
      await page.waitForTimeout(500)
      await shot('settings-limit-invalid')
      await limit.fill('75')
      await limit.blur()
    } else bad(j, 'no spending limit input after sign in')
    // Export
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
      page.getByRole('button', { name: /Export account data/ }).click(),
    ])
    if (dl) note(j, `export downloaded ${dl.suggestedFilename()}`)
    else bad(j, 'export did not trigger a download')
    await page.waitForTimeout(500)
    await shot('settings-exported')
    // Composer picks up the default limit?
    await page.goto(base + '/new', { waitUntil: 'domcontentloaded' })
    await settle(page)
    const v = await page.locator('#f-funding-spendingLimit').inputValue().catch(() => null)
    note(j, `composer spending limit after setting default 75 → ${v}`)
  },

  async compose(page, j, shot) {
    await page.goto(base + '/new?qa=1', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await shot('empty')
    await page.locator('#gh-input').fill('kleros/gateway-balancer-bot/pull/47')
    await page.waitForTimeout(1500)
    await shot('resolved')
    await page.locator('#gh-input').press('Enter')
    await page.waitForTimeout(800)
    await shot('pinned')
    await page.locator('input[name="policy"][value="BOT-001"]').check()
    await page.waitForTimeout(300)
    await page.fill('#f-spec-title', 'Reporter deposits never draw principal from protected funds')
    await page.fill('#f-spec-requirement', 'Each reporter-funding deposit principal is allocated only from eligible bridging funds and never from arbitration allocations or the operator gas reserve.')
    await page.fill('#f-spec-violation', 'reporter-deposit principal can consume arbitration allocations or the operator transaction-gas reserve')
    await page.evaluate(() => document.getElementById('sec-claim')?.scrollIntoView({ block: 'start' }))
    await shot('claim-filled')
    // Fill policy params via the "example" affordance if present, else by hand
    const ex = page.getByRole('button', { name: /example/i }).first()
    if (await ex.isVisible().catch(() => false)) {
      await ex.click()
      note(j, 'used example fill')
    } else {
      note(j, 'no example-fill affordance for policy parameters')
    }
    await page.waitForTimeout(400)
    const issues = await page.locator('text=/\\d+ problems?/').first().innerText().catch(() => '?')
    note(j, `problems after claim: ${issues}`)
    await shot('after-params')
    await page.getByRole('button', { name: 'Add in-scope item' }).click()
    await page.keyboard.type('src/funding/reporter-planner.ts')
    await page.fill('#f-spec-environment-runtime', 'node 22.14.0')
    await page.fill('#f-spec-environment-reproductionCommand', 'pnpm vitest run test/reporter-funding.spec.ts')
    await page.evaluate(() => document.getElementById('sec-environment')?.scrollIntoView({ block: 'start' }))
    await shot('environment')
    await page.evaluate(() => document.getElementById('sec-deadlines')?.scrollIntoView({ block: 'start' }))
    await page.getByRole('button', { name: '7 days' }).click()
    await shot('deadlines')
    await page.evaluate(() => document.getElementById('sec-funding')?.scrollIntoView({ block: 'start' }))
    await shot('funding')
    // Price input: clear and retype (controlled numeric inputs must not fight the user)
    const yes = page.locator('#f-funding-initialYesPrice')
    await yes.click()
    await yes.press('End')
    await yes.press('Backspace')
    await yes.press('Backspace')
    await yes.press('Backspace')
    await yes.press('Backspace')
    await yes.type('25')
    await yes.blur()
    note(j, `initial YES after clearing and typing 25 → ${await yes.inputValue()}`)
    await page.evaluate(() => document.getElementById('sec-review')?.scrollIntoView({ block: 'start' }))
    await shot('review')
    const left = await page.locator('text=/\\d+ problems?/').first().innerText().catch(() => '?')
    note(j, `problems before publish: ${left}`)
    await connectWallet(page)
    await page.locator('#ack').check()
    await page.waitForTimeout(300)
    await shot('review-ready')
    await page.getByRole('button', { name: 'Publish claim and create market' }).click()
    await page.waitForSelector('text=Mark done', { timeout: 30000 }).catch(() => bad(j, 'never reached manual DEX step'))
    await page.evaluate(() => document.querySelector('[aria-live="polite"] ol')?.scrollIntoView({ block: 'center' }))
    await shot('dex-manual')
    for (let i = 0; i < 2; i++) {
      const done = page.getByRole('button', { name: 'Mark done' }).first()
      await done.waitFor({ timeout: 20000 }).catch(() => {})
      if (await done.isVisible().catch(() => false)) await done.click()
      await page.waitForTimeout(800)
    }
    await page.waitForSelector('text=All steps confirmed', { timeout: 30000 }).catch(() => bad(j, 'publish never finished'))
    await shot('published')
    const open = page.getByRole('link', { name: 'Open claim' })
    if (await open.isVisible().catch(() => false)) {
      await open.click()
      await settle(page)
      await shot('new-claim')
      note(j, `published claim url ${page.url()}`)
    } else bad(j, 'no Open claim link after publishing')
  },

  async publishfail(page, j, shot) {
    // Failure then retry on the seeded draft
    await page.goto(base + '/new?draft=draft-bkt41q&qa=1', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#sec-review', { timeout: 20000 })
    await connectWallet(page)
    await page.evaluate(() => document.getElementById('sec-review')?.scrollIntoView({ block: 'start' }))
    await page.locator('#ack').check()
    const arm = page.getByRole('button', { name: /Simulate failure on next transaction/ }).first()
    await arm.click()
    await page.waitForTimeout(300)
    await shot('armed')
    await page.getByRole('button', { name: 'Publish claim and create market' }).click()
    await page.waitForSelector('text=Retry step', { timeout: 30000 }).catch(() => bad(j, 'no retry after failure'))
    await page.evaluate(() => document.querySelector('[aria-live="polite"] ol')?.scrollIntoView({ block: 'center' }))
    await shot('failed')
    await page.getByRole('button', { name: 'Retry step' }).first().click()
    await page.waitForTimeout(1500)
    await shot('retried')
    // Reload mid-publish (paused at the DEX step) and resume
    await page.waitForSelector('text=Mark done', { timeout: 30000 }).catch(() => {})
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#sec-review', { timeout: 20000 })
    await settle(page, 1500)
    await shot('after-reload')
    await page.evaluate(() => document.getElementById('sec-review')?.scrollIntoView({ block: 'start' }))
    await page.waitForTimeout(400)
    await shot('after-reload-review')
    const resume = page.getByRole('button', { name: /^Resume$/ }).first()
    if (await resume.isVisible().catch(() => false)) {
      await resume.click()
      await page.waitForTimeout(1500)
    }
    const done = page.getByRole('button', { name: 'Mark done' }).first()
    if (await done.isVisible().catch(() => false)) note(j, 'manual DEX step visible after reload')
    else bad(j, 'manual DEX step not visible after reload/resume')
    await shot('resumed')
  },

  async evidence(page, j, shot) {
    for (const mode of ['direct', 'commit']) {
      await page.goto(base + '/claims/pine-0009?qa=1', { waitUntil: 'domcontentloaded' })
      await settle(page)
      if (!VP.isMobile) {
        await page.keyboard.press('e')
        await page.waitForURL(/evidence\/new/, { timeout: 8000 }).catch(() => bad(j, '`e` did not open evidence form'))
      } else {
        await page.getByRole('link', { name: /Submit evidence/ }).first().click()
      }
      await settle(page)
      if (mode === 'direct') await shot('form-empty')
      // Try submitting empty to see the validation UX
      await page.getByRole('button', { name: /^Submit (evidence|commitment)$/ }).click()
      await page.waitForTimeout(400)
      if (mode === 'direct') await shot('form-empty-submit', { full: true })
      if (mode === 'commit') await page.getByRole('radio', { name: /Commit, reveal later/ }).click()
      await page.fill('#ev-title', `Top-up draws principal from arbitration allocation (${mode})`)
      await page.fill('#ev-summary', 'Seed an underfunded reporter, run the planner, observe the allocation **drop** by the deposit principal.')
      await page.fill('#ev-exp', 'arbitration allocation unchanged')
      await page.fill('#ev-act', 'arbitration allocation reduced by 0.05 xDAI')
      const boxes = page.locator('fieldset:has(legend:has-text("Admissibility")) input[type=checkbox]')
      const n = await boxes.count()
      for (let i = 0; i < n; i++) await boxes.nth(i).check()
      await connectWallet(page)
      await page.waitForTimeout(300)
      await shot(`${mode}-filled`)
      await page.getByRole('button', { name: /^Submit (evidence|commitment)$/ }).click()
      await page.waitForSelector('text=Evidence submitted', { timeout: 30000 }).catch(() => bad(j, `${mode}: never reached submitted`))
      await page.evaluate(() => document.querySelector('[aria-live="polite"]')?.scrollIntoView({ block: 'center' }))
      await shot(`${mode}-submitted`)
      const view = page.getByRole('link', { name: 'View evidence' })
      if (await view.isVisible().catch(() => false)) {
        await view.click()
        await settle(page)
        await shot(`${mode}-in-list`)
        const has = await page.getByText(`(${mode})`).first().isVisible().catch(() => false)
        if (!has) bad(j, `${mode}: submitted evidence not visible on the claim evidence tab`)
      }
    }
  },

  async dashboard(page, j, shot) {
    await page.goto(base + '/dashboard?qa=1', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await shot('disconnected', { full: true })
    await connectWallet(page)
    await settle(page)
    await shot('connected', { full: true })
    // Redeem on a resolved claim
    const redeem = page.getByRole('link', { name: /Redeem/ }).first()
    if (await redeem.isVisible().catch(() => false)) {
      note(j, `dashboard redeem button: "${await redeem.innerText()}"`)
      await redeem.click()
      await page.waitForTimeout(600)
      await shot('redeem-open')
      const start = page.getByRole('button', { name: /^Redeem$|^Start$|^Redeem / }).first()
      if (await start.isVisible().catch(() => false)) await start.click()
      await page.waitForTimeout(2500)
      await shot('redeem-done')
    } else {
      note(j, 'no redeem button on dashboard; trying a resolved claim page')
      await page.goto(base + '/claims/pine-0003?qa=1', { waitUntil: 'domcontentloaded' })
      await settle(page)
      await connectWallet(page)
      await page.waitForTimeout(600)
      await shot('claim-redeem-rail')
    }
    // Finish publishing pine-0015
    await page.goto(base + '/claims/pine-0015?qa=1', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await connectWallet(page)
    await page.waitForTimeout(600)
    await shot('recover-connected')
    const resume = page.getByRole('button', { name: /Resume publishing/ }).first()
    if (await resume.isVisible().catch(() => false)) {
      await resume.click()
      await page.waitForSelector('text=Mark done', { timeout: 30000 }).catch(() => bad(j, 'recovery never reached DEX step'))
      await shot('recover-dex')
      for (let i = 0; i < 2; i++) {
        const done = page.getByRole('button', { name: 'Mark done' }).first()
        await done.waitFor({ timeout: 15000 }).catch(() => {})
        if (await done.isVisible().catch(() => false)) await done.click()
        await page.waitForTimeout(900)
      }
      await page.waitForTimeout(1500)
      await shot('recover-done', { full: true })
      const status = await page.locator('main').innerText().catch(() => '')
      note(j, `after recovery: open=${/Open for evidence/.test(status)} publishing=${/Finish publishing/.test(status)}`)
    } else bad(j, 'no Resume publishing button on pine-0015')
  },

  async keyboard(page, j, shot) {
    await page.goto(base + '/claims', { waitUntil: 'domcontentloaded' })
    await settle(page)
    await page.keyboard.press('Shift+Slash')
    await page.waitForTimeout(300)
    await shot('shortcuts')
    await page.keyboard.press('Escape')
    await page.keyboard.press('g')
    await page.keyboard.press('d')
    await page.waitForURL(/dashboard/, { timeout: 5000 }).catch(() => bad(j, 'g d did not go to dashboard'))
    await page.keyboard.press('g')
    await page.keyboard.press('p')
    await page.waitForURL(/policies/, { timeout: 5000 }).catch(() => bad(j, 'g p did not go to policies'))
    await page.keyboard.press('n')
    await page.waitForURL(/\/new/, { timeout: 5000 }).catch(() => bad(j, 'n did not open composer'))
    await settle(page)
    // Palette: search a claim and open it
    await openPalette(page)
    await page.keyboard.type('keeper')
    await page.waitForTimeout(500)
    await shot('palette-keeper')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1200)
    note(j, `palette "keeper" + Enter → ${page.url()}`)
    // Palette: paste a PR URL
    await openPalette(page)
    await page.keyboard.insertText('https://github.com/kleros/gateway-balancer-bot/pull/47')
    await page.waitForTimeout(1500)
    await shot('palette-pr')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2000)
    note(j, `palette PR + Enter → ${page.url()}`)
    await shot('palette-pr-composer')
    // Tab focus visibility on claim page
    await page.goto(base + '/claims/pine-0009', { waitUntil: 'domcontentloaded' })
    await settle(page)
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab')
    await shot('focus-6-tabs')
    const focused = await page.evaluate(() => {
      const el = document.activeElement
      return el ? `${el.tagName} ${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40)}` : 'none'
    })
    note(j, `after 6 tabs focus is on: ${focused}`)
    await page.keyboard.press('3')
    await page.waitForTimeout(400)
    note(j, `after "3": ${page.url()}`)
    await page.keyboard.press('t')
    await page.waitForTimeout(300)
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    note(j, `after "t": data-theme=${theme}`)
    await shot('theme-cycled')
  },

  async pages(page, j, shot) {
    for (const p of ['/policies', '/policies/BOT-001', '/policies/SC-001', '/activity', '/agents', '/risks', '/drafts', '/repos', '/nope-404']) {
      await page.goto(base + p, { waitUntil: 'domcontentloaded' })
      await settle(page, 400)
      await shot(p.replace(/\W+/g, '_'), { full: true })
    }
  },
}

const browser = await launch()
await mkdir(outDir, { recursive: true })
for (const [name, fn] of Object.entries(JOURNEYS)) {
  if (pick && !pick.includes(name)) continue
  console.log(`▶ ${name} (${vpName}${dark ? ' dark' : ''})`)
  for (const f of (await readdir(outDir)).filter((f) => f.startsWith(`${name}-`))) await rm(path.join(outDir, f))
  const context = await browser.newContext({
    viewport: { width: VP.width, height: VP.height },
    isMobile: VP.isMobile,
    hasTouch: VP.isMobile,
    deviceScaleFactor: 1,
    colorScheme: dark ? 'dark' : 'light',
    reducedMotion: 'reduce',
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => bad(name, `pageerror ${e.message.slice(0, 200)}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Download the React DevTools|WalletConnect|reown|web3modal|404 \(Not Found\)|Lit is in dev/i.test(m.text())) bad(name, `console ${m.text().slice(0, 200)}`)
  })
  try {
    await fn(page, name, makeShot(page, name), context)
  } catch (e) {
    bad(name, `FAILED ${e.message.split('\n')[0]}`)
    await page.screenshot({ path: path.join(outDir, `${name}-zz-failure.png`) }).catch(() => {})
  }
  await context.close()
}
await browser.close()
console.log(problems ? `\n${problems} problem(s) logged` : '\nno problems logged')
