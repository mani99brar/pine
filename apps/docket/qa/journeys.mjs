// First-time-user journeys for Pine Docket, at desktop and phone widths.
// Each journey walks a real flow, takes viewport-sized shots of what a person would look at,
// runs axe-core on each page it lands on, and reports page errors and horizontal overflow.
//
// Usage: node qa/journeys.mjs [journey...] [--vp=desktop|mobile] [--no-axe]
//   journeys: land, account, wizard, exhibit, mydocket, states, misc, print   (default: all)
// Shots go to apps/docket/.qa/j/<journey>-<viewport>-<nn>-<name>.png
import { chromium } from '@playwright/test'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.qa', 'j')
const args = process.argv.slice(2)
const only = args.filter((a) => !a.startsWith('--'))
const vpArg = args.find((a) => a.startsWith('--vp='))?.slice(5)
const AXE = !args.includes('--no-axe')

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
].filter((v) => !vpArg || v.name === vpArg)

function launchOptions() {
  try {
    if (existsSync(chromium.executablePath())) return {}
  } catch {
    /* fall through */
  }
  const dir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
  for (const entry of existsSync(dir) ? readdirSync(dir).sort().reverse() : []) {
    const c = path.join(dir, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
    if (existsSync(c)) return { executablePath: c }
  }
  return {}
}

let axePath
try {
  const require = createRequire(import.meta.url)
  axePath = require.resolve('axe-core/axe.min.js')
} catch {
  const pnpmDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_modules', '.pnpm')
  const entry = existsSync(pnpmDir) ? readdirSync(pnpmDir).find((d) => d.startsWith('axe-core@')) : undefined
  axePath = entry ? path.join(pnpmDir, entry, 'node_modules', 'axe-core', 'axe.min.js') : undefined
}

const findings = []
const note = (msg) => {
  findings.push(msg)
  console.log('  !', msg)
}

function makeJ(page, journey, vp) {
  let n = 0
  const audited = new Set()
  const j = {
    page,
    vp,
    async go(url) {
      await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' })
      await j.settle()
    },
    async settle(ms = 600) {
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
      await page.waitForTimeout(ms)
    },
    async shot(name, opts = {}) {
      n++
      const file = path.join(OUT, `${journey}-${vp.name}-${String(n).padStart(2, '0')}-${name}.png`)
      await page.screenshot({ path: file, fullPage: !!opts.full })
      console.log('shot', path.basename(file))
      return file
    },
    async at(selector, name, block = 'start') {
      const el = page.locator(selector).first()
      if (!(await el.count())) {
        note(`${journey}/${vp.name}: ${selector} not found for shot ${name}`)
        return
      }
      await el.evaluate((e, b) => {
        e.scrollIntoView({ block: b })
      }, block)
      await page.waitForTimeout(300)
      return j.shot(name)
    },
    async slices(name, max = 30) {
      const total = await page.evaluate(() => document.documentElement.scrollHeight)
      const h = vp.height
      for (let y = 0, i = 0; y < total && i < max; y += h - 60, i++) {
        await page.evaluate((yy) => window.scrollTo(0, yy), y)
        await page.waitForTimeout(150)
        await j.shot(`${name}-${i}`)
      }
      await page.evaluate(() => window.scrollTo(0, 0))
    },
    async overflow(label) {
      const o = await page.evaluate(() => {
        const w = document.documentElement.clientWidth
        const wide = [...document.querySelectorAll('body *')].filter((el) => {
          const r = el.getBoundingClientRect()
          return r.right > w + 1 && getComputedStyle(el).position !== 'fixed' && r.width > 0
        })
        return {
          scroll: document.documentElement.scrollWidth > w,
          offenders: wide.slice(0, 4).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)}`),
        }
      })
      if (o.scroll) note(`${journey}/${vp.name} ${label}: horizontal overflow ${o.offenders.join(' | ')}`)
    },
    async axe(label) {
      if (!AXE || !axePath) return
      const key = page.url().split('#')[0]
      if (audited.has(key)) return
      audited.add(key)
      await page.addScriptTag({ path: axePath }).catch(() => {})
      const res = await page
        .evaluate(async () => {
          // eslint-disable-next-line no-undef
          const r = await axe.run(document, { resultTypes: ['violations'] })
          return r.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            help: v.help,
            nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary ?? '').split('\n').slice(1, 2).join('')),
            count: v.nodes.length,
          }))
        })
        .catch((e) => [{ id: 'axe-error', impact: 'n/a', help: e.message, nodes: [], count: 0 }])
      for (const v of res) note(`${journey}/${vp.name} ${label} axe[${v.impact}] ${v.id} (${v.count}): ${v.help} → ${v.nodes.join(' || ')}`)
    },
    async check(label) {
      await j.overflow(label)
      await j.axe(label)
    },
    async text(selector = 'main') {
      return (await page.locator(selector).first().innerText().catch(() => '')).replace(/\n+/g, ' | ')
    },
    async click(locator, label) {
      try {
        await locator.first().click({ timeout: 8000 })
        return true
      } catch (e) {
        note(`${journey}/${vp.name}: could not click ${label}: ${e.message.split('\n')[0]}`)
        return false
      }
    },
  }
  return j
}

async function signIn(j) {
  const { page } = j
  await j.go('/account')
  const btn = page.getByRole('button', { name: /sign in/i }).first()
  if (await btn.isVisible().catch(() => false)) {
    await btn.click()
    await page.waitForTimeout(2500)
    await j.settle()
  }
}

const SAMPLE = {
  'f-title': 'Reporter deposits never draw on protected funds',
  'f-requirement': 'Each reporter-funding deposit is paid only from bridging and reporter funds, never from a pair’s arbitration allocation or the operator gas reserve.',
  'f-violation': 'a reporter-funding deposit draws principal from a pair’s arbitration allocation or the operator gas reserve',
  'f-runtime': 'node 22.14.0',
  'f-command': 'pnpm vitest run test/reporter-funding.spec.ts',
}

/** Fill one wizard field by id the way a person would. */
async function fillField(page, id) {
  if (!id) return
  const el = page.locator(`[id="${id}"]`).first()
  if (!(await el.count())) return
  const tag = await el.evaluate((e) => e.tagName.toLowerCase())
  const type = await el.getAttribute('type').catch(() => null)
  if (tag === 'select') {
    const opts = await el.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean))
    if (opts[0]) await el.selectOption(opts[0])
  } else if (tag === 'textarea' || (tag === 'input' && (!type || type === 'text' || type === 'url' || type === 'email'))) {
    const value = SAMPLE[id] ?? (id.includes('param') ? 'Reporter deposits and arbitration allocations are tracked separately' : 'Example entry for review')
    await el.fill(value)
    // A list input needs Enter to add the item
    const addBtn = el.locator('xpath=following-sibling::button').first()
    if (await addBtn.count()) await el.press('Enter')
  } else if (tag === 'div' || tag === 'fieldset') {
    const box = el.locator('input[type="checkbox"], input[type="radio"]').first()
    if (await box.count()) await box.check().catch(() => box.click())
  }
}

async function connectWallet(j) {
  const { page } = j
  const c = page.getByRole('button', { name: /^connect wallet$/i }).first()
  if (await c.isVisible().catch(() => false)) {
    await c.click()
    await page.waitForTimeout(800)
  }
}

const JOURNEYS = {
  /** (a) land → understand → how it works → docket → flagship claim */
  async land(j) {
    const { page } = j
    await j.go('/')
    await j.check('landing')
    await j.slices('landing', 8)
    await j.go('/how-it-works')
    await j.check('how')
    await j.slices('how', 10)
    await j.go('/docket')
    await j.check('docket')
    await j.slices('docket', 6)
    // Search and filters
    const search = page.getByRole('searchbox').or(page.getByLabel(/search/i)).first()
    if (await search.isVisible().catch(() => false)) {
      await search.fill('keeper')
      await page.waitForTimeout(800)
      await j.shot('docket-search-keeper')
      await search.fill('')
    } else note('land: no search box on docket')
    await j.go('/claims/pine-0009')
    await j.check('claim-0009')
    await j.slices('claim-0009', 16)
    // Hover a numbered note and a term
    const note1 = page.locator('#question [data-note], #question li').first()
    if (await note1.count()) {
      await note1.hover().catch(() => {})
      await page.waitForTimeout(300)
      await j.at('#question', 'question-hover')
    }
  },

  /** (b) sign in (demo) → account → link wallet → spending limit → export */
  async account(j) {
    const { page } = j
    await j.go('/account')
    await j.check('account-signedout')
    await j.shot('account-signedout')
    const btn = page.getByRole('button', { name: /sign in/i }).first()
    await j.click(btn, 'sign in')
    await page.waitForTimeout(2500)
    await j.settle()
    await j.check('account-signedin')
    await j.slices('account-signedin', 6)
    // Link the demo wallet
    const link = page.getByRole('button', { name: /link.*wallet|connect.*wallet/i }).first()
    if (await link.isVisible().catch(() => false)) {
      await link.click()
      await page.waitForTimeout(1500)
      const link2 = page.getByRole('button', { name: /link.*wallet|sign.*message|sign in with ethereum/i }).first()
      if (await link2.isVisible().catch(() => false)) {
        await link2.click()
        await page.waitForTimeout(2500)
      }
      await j.at('#wallets, [id*="wallet"]', 'after-link')
    } else note('account: no link-wallet button')
    // Spending limit
    const limit = page.getByLabel(/spending limit/i).first()
    if (await limit.isVisible().catch(() => false)) {
      await limit.fill('40')
      const save = page.getByRole('button', { name: /save/i }).first()
      if (await save.isVisible().catch(() => false)) {
        await save.click()
        await page.waitForTimeout(1200)
      }
      await limit.evaluate((e) => e.scrollIntoView({ block: 'center' }))
      await j.shot('limit-saved')
    } else note('account: no spending limit field')
    // Export
    const exp = page.getByRole('button', { name: /export|download my data/i }).or(page.getByRole('link', { name: /export/i })).first()
    if (await exp.isVisible().catch(() => false)) {
      const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null)
      await exp.click()
      const d = await dl
      console.log('export download:', d ? d.suggestedFilename() : 'none')
      await page.waitForTimeout(800)
      await j.shot('after-export')
    } else note('account: no export control')
  },

  /** (c) the filing wizard from a pasted PR to "Entered on the docket" */
  async wizard(j) {
    const { page } = j
    await signIn(j)
    await j.go('/file')
    await j.check('file-start')
    await j.slices('file-start', 4)
    // Start a blank filing
    const start = page.getByRole('button', { name: /start (a )?(new|blank)|start filing|new filing|begin/i }).first()
    if (!(await j.click(start, 'start a new filing'))) {
      const a = page.getByRole('link', { name: /start/i }).first()
      await j.click(a, 'start link')
    }
    await page.waitForURL(/\/file\/[^/?]+/, { timeout: 20000 }).catch(() => note('wizard: no draft url'))
    await j.settle()
    await j.check('wizard-source')
    await j.shot('source-empty')
    // Continue with nothing to see validation
    await j.click(page.getByRole('button', { name: /^continue/i }), 'continue empty')
    await page.waitForTimeout(500)
    await j.shot('source-validation')
    // Paste the PR
    const input = page.locator('#f-source').first()
    if (await input.isVisible().catch(() => false)) {
      await input.fill('kleros/gateway-balancer-bot/pull/47')
      await page.waitForTimeout(1500)
      await j.settle()
      await j.shot('source-pasted')
    } else note('wizard: #f-source missing')
    const pin = page.getByRole('button', { name: /^pin this commit$/i }).first()
    if (await pin.isVisible().catch(() => false)) {
      await pin.click()
      await page.waitForTimeout(900)
      await j.shot('source-pinned')
    } else note('wizard: no "Pin this commit"')
    await j.slices('source-after', 4)
    // Walk forward with Continue like a newcomer: when blocked, fill exactly what the error summary asks for.
    for (let i = 0; i < 24; i++) {
      const stepName = new URL(page.url()).searchParams.get('step') ?? 'source'
      if (stepName === 'policy' && !(await page.locator('input[name="policy"]:checked').count())) {
        await j.shot('policy-choose')
        await page.locator('label', { hasText: 'Automation and Keeper Reliability' }).first().click()
        await page.waitForTimeout(500)
        await j.slices('policy-chosen', 8)
      }
      await j.click(page.getByRole('button', { name: /^continue/i }), `continue from ${stepName}`)
      await page.waitForTimeout(700)
      const summary = page.locator('#error-summary')
      const s2 = new URL(page.url()).searchParams.get('step')
      if (await summary.isVisible().catch(() => false)) {
        await j.shot(`blocked-${s2}-${i}`)
        console.log('blocked at', s2, (await summary.innerText()).replace(/\n+/g, ' | '))
        const ids = await summary.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')?.slice(1)))
        for (const id of [...new Set(ids)]) await fillField(page, id)
        await page.waitForTimeout(400)
        continue
      }
      await j.check(`wizard-${s2}`)
      await j.slices(`step-${s2}`, 8)
      if (s2 === 'review') break
    }
  },

  /** (c, cont.) review → acks → publish with failure, reload, resume, manual DEX */
  async publish(j) {
    const { page } = j
    await j.go('/file?qa=1')
    await j.click(page.getByRole('button', { name: /worked example/i }), 'worked example')
    await page.waitForURL(/\/file\/[^/?]+/, { timeout: 20000 })
    await j.settle()
    const pin = page.getByRole('button', { name: /^pin this commit$/i }).first()
    await pin.waitFor({ timeout: 15000 }).catch(() => {})
    if (await pin.isVisible().catch(() => false)) await pin.click()
    await page.waitForTimeout(900)
    const draftUrl = page.url().split('?')[0]
    await page.goto(`${draftUrl}?step=review`, { waitUntil: 'domcontentloaded' })
    await j.settle()
    await j.check('review')
    await j.slices('review', 14)
    // Hover the third note in review
    const notes = page.locator('[id^="review-q-note"]')
    if (await notes.count()) {
      await notes.nth(2).hover().catch(() => {})
      await page.waitForTimeout(300)
      await j.shot('review-note-hover')
    }
    const boxes = page.locator('input[id^="ack-"]')
    const n = await boxes.count()
    for (let i = 0; i < n; i++) await boxes.nth(i).check()
    await j.at('#rv-risk', 'acks-ticked')
    await j.click(page.getByRole('button', { name: /continue: publish/i }), 'continue publish')
    await page.waitForTimeout(800)
    await j.check('publish')
    await j.slices('publish-before', 5)
    await connectWallet(j)
    await j.shot('publish-wallet')
    await page.getByRole('button', { name: /make the next transaction fail/i }).first().click().catch(() => note('publish: no fail-next control'))
    await j.click(page.getByRole('button', { name: /^sign and file/i }), 'sign and file')
    await page.waitForTimeout(2500)
    await j.shot('publish-failed')
    await j.slices('publish-failed', 4)
    // Reload mid-way and resume
    await page.reload({ waitUntil: 'domcontentloaded' })
    await j.settle(1200)
    await j.shot('publish-reloaded')
    const retry = page.getByRole('button', { name: /retry|resume|continue/i }).first()
    console.log('resume control:', await retry.innerText().catch(() => 'none'))
    await j.click(retry, 'retry/resume')
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1200)
      const md = page.getByRole('button', { name: /mark done/i }).first()
      if (await md.isVisible().catch(() => false)) {
        if (i < 2) await j.shot(`manual-dex-${i}`)
        await md.click()
      }
    }
    await page.waitForTimeout(1500)
    await j.shot('publish-done')
    await j.slices('publish-done', 4)
    const open = page.getByRole('link', { name: /open the case file/i })
    const href = await open.getAttribute('href').catch(() => null)
    console.log('done link', href)
    if (href) {
      await j.go(href)
      await j.slices('new-claim', 4)
    }
  },

  /** (d) file an exhibit: direct and commit modes */
  async exhibit(j) {
    const { page } = j
    await j.go('/claims/pine-0009/evidence?qa=1')
    await j.check('evidence')
    await j.slices('evidence', 8)
    await connectWallet(j)
    await j.click(page.getByRole('button', { name: /^file exhibit/i }), 'file exhibit empty')
    await page.waitForTimeout(500)
    await j.shot('evidence-errors')
    await page.fill('#ex-title', 'Reporter top-up borrows from the arbitration allocation after a timeout').catch(() => note('no #ex-title'))
    await page.fill('#ex-summary', 'After a **timeout** during the bridging-fee read, the planner falls back to the pair allocation.').catch(() => {})
    await page.fill('#ex-expected', 'The top-up is skipped and reporter.underfunded is emitted.').catch(() => {})
    await page.fill('#ex-actual', 'A 4.2 xDAI deposit is planned with source = arbitration.').catch(() => {})
    const boxes = page.locator('input[id^="adm-"]')
    const n = await boxes.count()
    for (let i = 0; i < n; i++) await boxes.nth(i).check()
    await j.click(page.getByRole('button', { name: /^file exhibit/i }), 'file exhibit')
    await page.waitForTimeout(4000)
    await j.shot('evidence-done')
    await j.slices('evidence-done', 3)
    // Commit mode
    await j.go('/claims/pine-0009/evidence?qa=1')
    const sealed = page.getByLabel(/sealed|commit/i).first()
    if (await sealed.isVisible().catch(() => false)) {
      await sealed.check().catch(() => sealed.click())
      await page.waitForTimeout(500)
      await j.slices('evidence-sealed', 8)
    } else note('exhibit: no sealed/commit mode control found by label')
  },

  /** (e) My docket: redeem on a resolved claim, finish filing pine-0015 */
  async mydocket(j) {
    const { page } = j
    await j.go('/my-docket?qa=1')
    await j.shot('my-docket-signedout')
    await signIn(j)
    await j.go('/my-docket')
    await connectWallet(j)
    await j.settle()
    await j.check('my-docket')
    await j.slices('my-docket', 8)
    await j.go('/claims/pine-0002')
    await connectWallet(j)
    await j.at('#position', 'redeem-before')
    await j.click(page.locator('#position').getByRole('button', { name: /^redeem/i }), 'redeem')
    await page.waitForTimeout(3000)
    await j.at('#position', 'redeem-after')
    await j.go('/claims/pine-0015')
    await j.check('claim-0015')
    await j.slices('claim-0015', 4)
    await j.click(page.locator('#filing').getByRole('button', { name: /finish filing/i }), 'finish filing')
    await page.waitForTimeout(3000)
    await j.at('#filing', 'finish-1')
    for (let i = 0; i < 3; i++) {
      const md = page.getByRole('button', { name: /mark done/i }).first()
      if (await md.isVisible().catch(() => false)) {
        await md.click()
        await page.waitForTimeout(1500)
      }
    }
    // Once filing finishes the claim is open and the "Finish filing" section is gone by design.
    if (await page.locator('#filing').count()) note(`mydocket/${j.vp.name}: #filing still shown after finishing`)
    await j.at('#standing', 'finish-standing')
    await j.go('/filings')
    await j.check('filings')
    await j.slices('filings', 4)
    await j.go('/activity')
    await j.check('activity')
    await j.slices('activity', 6)
  },

  /** (f) claim states */
  async states(j) {
    for (const [id, label] of [
      ['pine-0006', 'disputed'],
      ['pine-0005', 'arbitration'],
      ['pine-0001', 'resolved-a'],
      ['pine-0002', 'resolved-b'],
      ['pine-0003', 'resolved-c'],
      ['pine-0004', 'resolved-d'],
      ['pine-0016', 'failed'],
      ['pine-0010', 'hostile'],
      ['pine-0007', 's7'],
      ['pine-0008', 's8'],
    ]) {
      await j.go(`/claims/${id}`)
      await j.check(`claim-${id}`)
      const status = await j.text('#standing')
      console.log(id, label, '::', status.slice(0, 200))
      await j.shot(`${id}-${label}-top`)
      await j.at('#oracle', `${id}-oracle`)
      await j.at('#outcome', `${id}-outcome`)
      if (label === 'hostile') await j.at('#exhibits', `${id}-exhibits`)
      if (label === 'hostile') await j.slices(`${id}-all`, 14)
    }
  },

  /** (g) policies, activity, agents, risks, 404, repositories */
  async misc(j) {
    for (const [u, name] of [
      ['/policies', 'policies'],
      ['/policies/BOT-001', 'policy-bot'],
      ['/policies/SC-001', 'policy-sc'],
      ['/agents', 'agents'],
      ['/risks', 'risks'],
      ['/repositories', 'repositories'],
      ['/repositories/kleros/gateway-balancer-bot', 'repo'],
      ['/repositories/kleros/gateway-balancer-bot/pull/47', 'pull'],
      ['/no-such-page', '404'],
      ['/claims/pine-9999', 'claim-404'],
      ['/docket?q=zzzz-nothing', 'docket-empty'],
    ]) {
      await j.go(u)
      await j.check(name)
      await j.slices(name, 8)
    }
  },

  /** (h) print preview */
  async print(j) {
    const { page } = j
    if (j.vp.name !== 'desktop') return
    await page.emulateMedia({ media: 'print' })
    await j.go('/claims/pine-0009')
    await page.setViewportSize({ width: 820, height: 1160 })
    await page.waitForTimeout(500)
    await j.slices('print', 14)
    await page.pdf({ path: path.join(OUT, 'print-0009.pdf'), format: 'A4', printBackground: true }).catch(() => {})
    await page.emulateMedia({ media: 'screen' })
  },
}

await mkdir(OUT, { recursive: true })
const browser = await chromium.launch(launchOptions())
for (const vp of VIEWPORTS) {
  for (const [name, fn] of Object.entries(JOURNEYS)) {
    if (only.length && !only.includes(name)) continue
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, reducedMotion: 'reduce', acceptDownloads: true })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => note(`${name}/${vp.name} pageerror ${page.url()}: ${e.message.slice(0, 200)}`))
    page.on('console', (m) => {
      if (m.type() === 'error') note(`${name}/${vp.name} console ${page.url()}: ${m.text().slice(0, 200)}`)
    })
    console.log(`\n== ${name} @ ${vp.name}`)
    await page.goto(`${BASE}/?qa=1`, { waitUntil: 'domcontentloaded' })
    try {
      await fn(makeJ(page, name, vp))
    } catch (e) {
      note(`${name}/${vp.name} crashed: ${e.message.split('\n')[0]}`)
    }
    await ctx.close()
  }
}
await browser.close()
console.log(`\n${findings.length} findings`)
for (const f of [...new Set(findings)]) console.log(' -', f)
