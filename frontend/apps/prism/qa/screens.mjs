// Pine Prism screenshot QA.
//   node qa/screens.mjs                 desktop 1440×900, motion on, WebGL on
//   node qa/screens.mjs --mobile        390×844
//   node qa/screens.mjs --reduced       prefers-reduced-motion: reduce
//   node qa/screens.mjs --nowebgl       Chromium launched with --disable-webgl
//   node qa/screens.mjs --only=claim    run only sections whose name matches
//   node qa/screens.mjs --skip-compose  skip the composer journey
// Screens go to apps/prism/.qa/<tag>-<name>.png; a JSON report lists console errors and horizontal overflow.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, newPage, go, shot, overflow, log, OUT, BASE } from './lib.mjs'

const args = process.argv.slice(2)
const mobile = args.includes('--mobile')
const reduced = args.includes('--reduced')
const nowebgl = args.includes('--nowebgl')
const only = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1]
const tag = `${mobile ? 'm' : 'd'}${reduced ? 'r' : ''}${nowebgl ? 'n' : ''}`
const report = []

const ROUTES = [
  ['landing', '/', { full: !mobile, wait: 3200 }],
  ['table', '/claims', { full: true }],
  ['table-list', '/claims?view=list', {}],
  ['claim-open', '/claims/pine-0009', { full: !mobile }],
  ['claim-hostile', '/claims/pine-0010#evidence', { wait: 1500 }],
  ['claim-awaiting', '/claims/pine-0008', {}],
  ['claim-proposed', '/claims/pine-0007', {}],
  ['claim-disputed', '/claims/pine-0006', {}],
  ['claim-arbitration', '/claims/pine-0005#oracle', {}],
  ['claim-yes', '/claims/pine-0002', { wait: 1800 }],
  ['claim-no', '/claims/pine-0003', {}],
  ['claim-invalid', '/claims/pine-0004', {}],
  ['claim-settled', '/claims/pine-0001', {}],
  ['claim-publishing', '/claims/pine-0015', {}],
  ['claim-failed', '/claims/pine-0016', {}],
  ['claim-missing', '/claims/pine-9999', {}],
  ['evidence', '/claims/pine-0009/evidence', { full: true }],
  ['drafts', '/drafts', {}],
  ['dashboard-out', '/dashboard', {}],
  ['account-out', '/account', {}],
  ['repos', '/repos', {}],
  ['repo', '/repos/kleros/gateway-balancer-bot?pr=47', { full: true }],
  ['repo-private', '/repos/mara-okafor/ops-runbooks', {}],
  ['policies', '/policies', {}],
  ['policy', '/policies/BOT-001', {}],
  ['policy-gated', '/policies/SC-001', {}],
  ['activity', '/activity', {}],
  ['agents', '/agents', {}],
  ['risks', '/risks', {}],
  ['notfound', '/no-such-page', {}],
]

const browser = await launch({ webgl: !nowebgl })
const page = await newPage(browser, { mobile, reduced })
await page.context().setDefaultTimeout(30000)

async function capture(name, path, opts = {}) {
  if (only && !name.includes(only)) return
  page.errors = []
  try {
    await go(page, path, { wait: opts.wait ?? 1100 })
    await shot(page, `${tag}-${name}`, Boolean(opts.full))
    const ov = await overflow(page)
    report.push({ name, path, errors: [...page.errors], overflow: ov })
    log(`${ov || page.errors.length ? '!' : '✓'} ${name}${ov ? ` overflow ${ov.scrollWidth}>${ov.clientWidth}` : ''}${page.errors.length ? ` errors ${page.errors.length}` : ''}`)
  } catch (e) {
    report.push({ name, path, errors: [String(e)] })
    log(`✗ ${name}: ${e.message}`)
  }
}

for (const [name, path, opts] of ROUTES) await capture(name, path, opts)

// Landing scroll positions (mobile full-page captures exceed the screenshot size limit)
if (mobile && (!only || 'landing'.includes(only))) {
  await go(page, '/', { wait: 2500 })
  for (const [i, y] of [900, 2600, 5200, 8200].entries()) {
    await page.evaluate((y) => window.scrollTo(0, y), y)
    await page.waitForTimeout(900)
    await shot(page, `${tag}-landing-scroll-${i}`)
  }
}

// Mobile navigation sheet
if (mobile && (!only || 'mobile-nav'.includes(only))) {
  await go(page, '/')
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.waitForTimeout(700)
  await shot(page, `${tag}-mobile-nav`)
  await page.keyboard.press('Escape')
}

// Signed in: account, dashboard with demo wallet
if (!only || 'signed'.includes(only)) {
  try {
    await go(page, '/account')
    const demoBtn = page.getByRole('button', { name: /demo identity/i }).first()
    if (await demoBtn.count()) {
      await demoBtn.click()
      await page.waitForURL(/account/, { timeout: 20000 }).catch(() => {})
      await page.waitForTimeout(2500)
    }
    await capture('account-in', '/account', { full: true })
    // Account journey: connect and link the demo wallet, set a default spending limit, export.
    page.errors = []
    const cw = page.getByRole('main').getByRole('button', { name: /connect demo wallet/i }).first()
    if (await cw.count()) await cw.click()
    await page.getByRole('button', { name: /link the connected wallet/i }).click({ timeout: 10000 }).catch(() => log('no link button'))
    await page.getByText(/The connected wallet is linked|Linked/).first().waitFor({ timeout: 15000 }).catch(() => log('wallet not linked'))
    await page.locator('#pref-limit').fill('120')
    await page.locator('#pref-limit').press('Enter')
    await page.getByText(/Default spending limit saved/).waitFor({ timeout: 10000 }).catch(() => log('limit not saved'))
    const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null)
    await page.getByRole('button', { name: /Export as JSON/ }).click()
    const file = await dl
    log(file ? `export: ${file.suggestedFilename()}` : 'no export download')
    await shot(page, `${tag}-account-journey`, true)
    report.push({ name: 'account-journey', errors: [...page.errors], overflow: await overflow(page) })
    await go(page, '/dashboard')
    const connect = page.getByRole('button', { name: /connect demo wallet/i }).first()
    if (await connect.count()) await connect.click()
    await page.waitForTimeout(1500)
    await shot(page, `${tag}-dashboard-in`, true)
    report.push({ name: 'dashboard-in', errors: [...page.errors], overflow: await overflow(page) })
  } catch (e) {
    log('signed-in section failed', e.message)
  }
}

// Journeys: redeem a resolved position, file evidence, finish a partial publication.
if (!only || 'journeys'.includes(only)) {
  try {
    page.errors = []
    await go(page, '/claims/pine-0002', { wait: 1500 })
    const cw = page.getByRole('button', { name: /connect demo wallet/i }).first()
    if (await cw.count()) await cw.click()
    await page.waitForTimeout(1200)
    const redeem = page.getByRole('button', { name: /^Redeem$/ })
    if (await redeem.count()) {
      await redeem.scrollIntoViewIfNeeded()
      await shot(page, `${tag}-journey-redeem-before`)
      await redeem.click()
      await page.getByText(/Redeemed/).first().waitFor({ timeout: 20000 }).catch(() => log('no redeemed text'))
      await page.waitForTimeout(600)
      await shot(page, `${tag}-journey-redeem-after`)
    } else log('no redeem button')

    await go(page, '/claims/pine-0009/evidence', { wait: 1500 })
    await page.locator('#ev-title').fill('Arbitration allocation funds a reporter top-up after a timeout')
    await page.locator('#ev-summary').fill('Running the planner after a bridge **timeout** funds the reporter deposit from the arbitration allocation.')
    await page.locator('#ev-cmd').fill('pnpm vitest run test/reporter-funding.spec.ts -t timeout')
    await page.locator('#ev-exp').fill('Top-up skipped and reporter.underfunded emitted')
    await page.locator('#ev-act').fill('Top-up of 40 sDAI drawn from the arbitration allocation')
    for (const cb of await page.locator('fieldset input[type="checkbox"]').all()) await cb.check()
    await shot(page, `${tag}-journey-evidence-filled`, true)
    const submit = page.getByRole('button', { name: /^Submit on/ })
    if (await submit.isEnabled()) {
      await submit.click()
      await page.getByText(/Your evidence is on-chain/).waitFor({ timeout: 30000 }).catch(() => log('evidence not done'))
      await page.waitForTimeout(600)
      await shot(page, `${tag}-journey-evidence-done`)
    } else log('submit disabled')

    // Commit-reveal mode: only the package hash goes on-chain.
    await go(page, '/claims/pine-0010/evidence', { wait: 1500 })
    await page.getByRole('radio', { name: /Commit, reveal later/ }).click()
    await page.locator('#ev-title').fill('Nested duplicate keys pass strict mode at depth 3')
    await page.locator('#ev-summary').fill('Package hash committed now; full repro revealed after the deadline.')
    for (const cb of await page.locator('fieldset input[type="checkbox"]').all()) await cb.check()
    const commit = page.getByRole('button', { name: /Commit the evidence hash/ })
    if (await commit.isEnabled()) {
      await commit.click()
      await page.getByText(/Your commitment is on-chain/).waitFor({ timeout: 30000 }).catch(() => log('commitment not done'))
      await page.waitForTimeout(500)
      await shot(page, `${tag}-journey-evidence-commit`)
    } else log('commit disabled')

    await go(page, '/claims/pine-0015', { wait: 1500 })
    const fin = page.getByRole('button', { name: /Finish publishing|Continue publishing/ }).first()
    if (await fin.count()) {
      await fin.click()
      await page.getByRole('button', { name: 'Mark done' }).first().waitFor({ timeout: 30000 }).catch(() => log('no manual step'))
      await shot(page, `${tag}-journey-finish-manual`)
    }
    report.push({ name: 'journeys', errors: [...page.errors], overflow: await overflow(page) })
    log(`journeys errors: ${page.errors.length}`)
  } catch (e) {
    report.push({ name: 'journeys', errors: [String(e)] })
    log('✗ journeys', e.message)
  }
}

// Composer journey: every stage, publish with a simulated failure, resume, manual DEX steps, seal.
if (!args.includes('--skip-compose') && (!only || 'compose'.includes(only))) {
  const c = (n) => shot(page, `${tag}-compose-${n}`)
  try {
    page.errors = []
    await go(page, '/compose', { wait: 1500 })
    await c('1-source')
    await page.locator('#source-input').fill('kleros/gateway-balancer-bot/pull/47')
    await page.getByRole('button', { name: 'Pin this commit' }).click({ timeout: 20000 })
    await page.waitForTimeout(900)
    await c('1b-pinned')
    await page.getByRole('button', { name: /Continue to policy/ }).click()
    await page.waitForTimeout(500)
    await page.getByRole('radio', { name: /BOT-001/ }).first().click()
    await page.waitForTimeout(500)
    await c('2-policy')
    await page.getByRole('button', { name: /Continue to claim/ }).click()
    await page.waitForTimeout(500)
    await page.locator('#title').fill('Reporter deposits never draw principal from arbitration reserves')
    await page.locator('#requirement').fill('Reporter top-ups are funded only from eligible bridging-fee allocations, never from the arbitration allocation or the operator gas reserve.')
    await page.locator('#violation').fill('that reporter-deposit principal can be funded from the arbitration allocation or the operator gas reserve')
    await page.locator('#in-scope').fill('src/funding/reporter-planner.ts')
    await page.locator('#in-scope').press('Enter')
    for (const p of await page.locator('input[id^="param-"], textarea[id^="param-"], select[id^="param-"]').all()) {
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
    // Policy vocabularies (multiselect chips): pick the first option when none is chosen.
    for (const group of await page.locator('div[id^="param-"]').all()) {
      if (!(await group.locator('button[aria-pressed="true"]').count())) await group.locator('button').first().click()
    }
    await page.waitForTimeout(700)
    await c('3-claim')
    await page.getByRole('button', { name: /Continue to environment/ }).click()
    await page.waitForTimeout(500)
    await page.locator('#runtime').fill('node 22.14.0')
    await page.locator('#repro').fill('pnpm vitest run test/reporter-funding.spec.ts')
    await page.waitForTimeout(700)
    await c('4-environment')
    await page.getByRole('button', { name: /Continue to deadlines/ }).click()
    await page.waitForTimeout(600)
    await c('5-deadlines')
    await page.getByRole('button', { name: /Continue to funding/ }).click()
    await page.waitForTimeout(600)
    await c('6-funding')
    await page.getByRole('button', { name: /Continue to review/ }).click()
    await page.waitForTimeout(600)
    await c('7-review')
    await page.locator('label:has-text("I have read these risks") input').check()
    await page.getByRole('button', { name: /Continue to publish/ }).click()
    await page.waitForTimeout(700)
    const connect = page.getByRole('button', { name: /Connect demo wallet/ }).first()
    if (await connect.count()) await connect.click()
    await page.waitForTimeout(800)
    await c('8-publish')
    // simulated failure on market creation, then retry
    const fail = page.getByRole('button', { name: /fail the next transaction/i }).first()
    if (await fail.count()) await fail.click()
    await page.getByRole('button', { name: /Publish and seal/ }).click()
    await page.waitForTimeout(3500)
    await c('9-failed')
    // reload mid-run: progress resumes
    await page.reload({ waitUntil: 'load' })
    await page.waitForTimeout(1500)
    await c('9b-reloaded')
    const retry = page.getByRole('button', { name: /Retry from the failed step|Continue publishing/ }).first()
    if (await retry.count()) await retry.click()
    await page.getByRole('button', { name: 'Mark done' }).first().waitFor({ timeout: 30000 }).catch(() => log('no manual step'))
    await c('10-sealed-manual')
    for (let i = 0; i < 3; i++) {
      const md = page.getByRole('button', { name: 'Mark done' }).first()
      if (!(await md.count())) break
      await md.click()
      await page.waitForTimeout(1500)
    }
    await page.waitForTimeout(1500)
    await c('11-done')
    report.push({ name: 'compose', errors: [...page.errors], overflow: await overflow(page) })
    log(`compose journey errors: ${page.errors.length}`)
  } catch (e) {
    await c('error').catch(() => {})
    report.push({ name: 'compose', errors: [String(e)] })
    log('✗ compose journey', e.message)
  }
}

await writeFile(join(OUT, `report-${tag}.json`), JSON.stringify(report, null, 2))
const bad = report.filter((r) => r.errors?.length || r.overflow)
log(`\n${report.length} captures, ${bad.length} with errors or overflow (base ${BASE})`)
for (const b of bad) log(` - ${b.name}: ${b.overflow ? 'overflow ' : ''}${(b.errors ?? []).slice(0, 2).join(' | ').slice(0, 300)}`)
await browser.close()
