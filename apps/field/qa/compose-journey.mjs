// Journey (c): paste a PR, pin, policy, sentence builder, deadlines, funding, review, publish with a
// simulated failure, reload mid-publish, resume, and the manual DEX steps.
import { launch, newPage, go, shot, log } from './lib.mjs'

const mobile = process.argv.includes('--mobile')
const dark = process.argv.includes('--dark')
const tag = `jc${mobile ? '-m' : ''}${dark ? '-d' : ''}`
const browser = await launch()
const page = await newPage(browser, { mobile, dark })
const t0 = Date.now()
const step = (s) => log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`)

await go(page, '/compose')
await page.locator('#source-input').fill('kleros/gateway-balancer-bot/pull/47')
await page.getByRole('button', { name: 'Pin this commit' }).click({ timeout: 15000 })
await page.waitForTimeout(1200)
step('pinned')
await page.getByRole('button', { name: 'Continue to policy' }).first().click()
await page.getByRole('radio', { name: /BOT-001/ }).first().click()
await page.getByRole('button', { name: 'Continue to claim' }).first().click()
await page.waitForTimeout(400)
log('scrollY after stage change', await page.evaluate(() => window.scrollY))
await shot(page, `${tag}-claim-top`)

// violation
await page.getByRole('button', { name: /^Violation/ }).click()
await page.locator('#violation').fill('that reporter-deposit principal can consume the arbitration allocation or the operator gas reserve')
await page.getByRole('button', { name: 'Done' }).click()
// basics
await page.getByRole('button', { name: /Title and requirement/ }).click()
await page.locator('#title').fill('Reporter deposits never draw principal from reserves')
await page.locator('#requirement').fill('Each reporter-funding deposit principal is allocated only from eligible bridging/reporter funds.')
await page.keyboard.press('Escape')
// scope
await page.getByRole('button', { name: /^Scope/ }).click()
await page.getByRole('textbox', { name: 'In scope 1' }).fill('src/funding/reporter-planner.ts')
await page.keyboard.press('Escape')
// environment
await page.getByRole('button', { name: /Environment and reproduction/ }).first().click()
await page.locator('#runtime').fill('node 22.14.0')
await page.locator('#repro').fill('pnpm vitest run test/reporter-funding.spec.ts')
await page.keyboard.press('Escape')
// params
await page.getByRole('button', { name: /BOT-001 parameters/ }).click()
await page.waitForTimeout(300)
await shot(page, `${tag}-params`)
const useExample = page.getByRole('button', { name: /Use the example/ })
if (await useExample.count()) {
  const n = await useExample.count()
  for (let i = 0; i < n; i++) await useExample.nth(0).click().catch(() => {})
  // buttons disappear once filled; click all remaining
  while ((await useExample.count()) > 0) await useExample.first().click()
} else {
  for (const k of ['invariant', 'sourceRequirement', 'permittedStartingStates', 'reachability', 'realIntegrationEvidence']) {
    await page.locator(`#param-${k}`).fill(`Example ${k}`)
  }
  for (const l of ['Accounts in scope', 'Chains in scope', 'Routes in scope', 'Accounting categories', 'Adapters that may be simulated']) {
    await page.getByRole('textbox', { name: `${l} 1` }).fill(`Example ${l}`)
  }
  await page.getByRole('button', { name: 'Timeout', exact: true }).click()
}
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
const issuesText = await page.locator('[role=status]').allInnerTexts()
log('claim-stage issues:', issuesText.join(' | ').slice(0, 300))
await shot(page, `${tag}-claim-filled`, true)
step('claim filled')

await page.getByRole('button', { name: 'Continue to deadlines' }).first().click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: '7 days' }).click().catch((e) => log('7 days', String(e).slice(0, 100)))
await shot(page, `${tag}-deadlines`, true)
await page.getByRole('button', { name: 'Continue to funding' }).first().click()
await page.waitForTimeout(400)
await shot(page, `${tag}-funding`, true)
await page.getByRole('button', { name: 'Continue to review' }).first().click()
await page.waitForTimeout(400)
await shot(page, `${tag}-review`, true)
const ack = page.getByRole('checkbox').first()
await ack.check()
await page.getByRole('button', { name: 'Continue to publish' }).first().click()
await page.waitForTimeout(500)
step('at publish')
await page.getByRole('button', { name: /Connect demo wallet/ }).first().click()
await page.waitForTimeout(800)
// arm a failure, then publish
await page.getByRole('button', { name: /Demo: fail the next transaction/ }).first().click()
await page.getByRole('button', { name: /^Publish$/ }).click()
await page.getByRole('button', { name: /Retry from the failed step/ }).waitFor({ timeout: 30000 })
step('failed as simulated')
await shot(page, `${tag}-publish-failed`, true)
await page.getByRole('button', { name: /Retry from the failed step/ }).click()
// wait until the market step confirms, then reload mid-publish
await page.getByText('Terms are frozen from here on').waitFor({ timeout: 40000 })
step('market created; reloading')
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
await shot(page, `${tag}-publish-reloaded`, true)
const cont = page.getByRole('button', { name: /^(Continue publishing|Publish)$/ }).first()
log('after reload button:', await cont.innerText().catch(() => 'none'), 'disabled', await cont.isDisabled().catch(() => '?'))
await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /^(Continue publishing|Publish)$/.test(b.textContent?.trim() ?? '') && !b.disabled), null, { timeout: 30000 })
log('resume button state after re-check:', await cont.isDisabled() ? 'disabled' : 'enabled')
await cont.click()
await page.getByRole('button', { name: 'Mark done' }).first().waitFor({ timeout: 40000 }).catch(async (e) => { await shot(page, `${tag}-resume-stuck`, true); log('stuck text:', (await page.locator('[role=alert]').allInnerTexts()).join(' | ')); throw e })
step('manual step 1')
await shot(page, `${tag}-manual`, true)
await page.getByRole('button', { name: 'Mark done' }).first().click()
await page.waitForTimeout(800)
const mark2 = page.getByRole('button', { name: 'Mark done' })
if (await mark2.count()) {
  await page.getByRole('textbox', { name: /Transaction hash/ }).first().fill('0x' + 'ab'.repeat(32))
  await mark2.first().click()
}
await page.waitForTimeout(1500)
await shot(page, `${tag}-published`, true)
log('published heading:', await page.getByRole('heading', { name: /on the board/ }).count())
log('errors', page.errors)
await browser.close()
