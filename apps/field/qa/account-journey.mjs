// Journey (b) account and (e) dashboard: sign in, link wallet, spending limit, export; redeem; finish pine-0015.
import { launch, newPage, go, shot, log } from './lib.mjs'
const mobile = process.argv.includes('--mobile')
const tag = `ja${mobile ? '-m' : ''}`
const browser = await launch()
const page = await newPage(browser, { mobile })

await go(page, '/account')
await shot(page, `${tag}-signin`, true)
await page.getByRole('button', { name: /demo identity/ }).first().click()
await page.getByRole('heading', { name: 'Account and settings' }).waitFor({ timeout: 20000 })
await page.waitForTimeout(600)
await page.getByRole('button', { name: /link a wallet|Link the connected wallet/ }).click()
await page.waitForTimeout(2500)
await shot(page, `${tag}-linked`, true)
log('link status:', await page.getByRole('button', { name: /linked|link/i }).first().innerText())
const limit = page.locator('#pref-limit')
await limit.fill('200')
await limit.press('Tab')
await page.waitForTimeout(800)
await shot(page, `${tag}-limit`)
const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null)
await page.getByRole('button', { name: 'Export as JSON' }).click()
const d = await dl
log('export download:', d ? d.suggestedFilename() : 'none')
await page.waitForTimeout(500)
await shot(page, `${tag}-export`)
// the default limit flows into a new claim's funding
await go(page, '/compose')
await page.locator('#source-input').fill('acme-labs/fastparse#231')
await page.getByRole('button', { name: 'Pin this commit' }).click({ timeout: 15000 })
await page.waitForTimeout(1000)
await page.getByRole('button', { name: /^5 Funding/ }).click()
await page.waitForTimeout(500)
log('composer spending limit:', await page.getByRole('textbox', { name: /Spending limit/i }).inputValue().catch(() => 'n/a'))

// dashboard: redeem
await go(page, '/dashboard')
await page.waitForTimeout(800)
await shot(page, `${tag}-dash`)
const redeem = page.getByRole('link', { name: /^Redeem/ }).or(page.getByRole('button', { name: /^Redeem/ })).first()
log('redeem control:', await redeem.evaluate((el) => el.tagName + ' ' + (el.getAttribute('href') || '')))
await redeem.click()
await page.waitForTimeout(1200)
log('url after redeem click:', page.url())
const rbtn = page.getByRole('button', { name: /^Redeem$/ })
if (await rbtn.count()) {
  await rbtn.click()
  await page.getByText(/Redeemed/).first().waitFor({ timeout: 20000 }).catch(() => log('no redeemed text'))
}
await shot(page, `${tag}-redeemed`, true)
// finish publishing pine-0015
await go(page, '/claims/pine-0015')
await page.waitForTimeout(500)
const fin = page.getByRole('button', { name: /Finish publishing|Resume|Continue/ }).first()
log('finish button:', await fin.innerText().catch(() => 'none'))
await fin.click()
await page.getByRole('button', { name: 'Mark done' }).first().waitFor({ timeout: 30000 }).catch(() => log('no manual step'))
await shot(page, `${tag}-finish-manual`, true)
while ((await page.getByRole('button', { name: 'Mark done' }).count()) > 0) {
  await page.getByRole('button', { name: 'Mark done' }).first().click()
  await page.waitForTimeout(1000)
}
await page.waitForTimeout(1500)
await shot(page, `${tag}-finished`, true)
log('errors', page.errors)
await browser.close()
