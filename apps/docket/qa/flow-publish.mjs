// Flow check: worked example → review acknowledgements → publish with the simulated wallet,
// including one forced failure and retry, then the manual DEX steps.
import { chromium } from '@playwright/test'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.qa', 'peek')
const W = Number(process.env.W ?? 1440)
function launchOptions() {
  try { if (existsSync(chromium.executablePath())) return {} } catch { /* */ }
  const dir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
  for (const entry of existsSync(dir) ? readdirSync(dir).sort().reverse() : []) {
    const c = path.join(dir, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
    if (existsSync(c)) return { executablePath: c }
  }
  return {}
}
const browser = await chromium.launch(launchOptions())
const page = await browser.newPage({ viewport: { width: W, height: 1000 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 300)))
await page.goto(`${BASE}/file?qa=1`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: /worked example/i }).click()
await page.waitForURL(/\/file\/[^/?]+/)
await page.getByRole('button', { name: /^pin this commit$/i }).first().click({ timeout: 15000 })
await page.waitForTimeout(800)
// Walk Continue through every step to exercise validation
for (let i = 0; i < 5; i++) {
  await page.getByRole('button', { name: /^continue/i }).click()
  await page.waitForTimeout(500)
  const summary = page.locator('#error-summary')
  if (await summary.isVisible().catch(() => false)) {
    console.log('blocked at', page.url().split('step=')[1], ':', (await summary.innerText()).replace(/\n+/g, ' | '))
    break
  }
}
console.log('now at', page.url().split('step=')[1])
const draftUrl = page.url().split('?')[0]
await page.goto(`${draftUrl}?step=review`, { waitUntil: 'networkidle' })
const boxes = page.locator('input[id^="ack-"]')
const n = await boxes.count()
for (let i = 0; i < n; i++) await boxes.nth(i).check()
console.log('acks', n)
await page.getByRole('button', { name: /continue: publish/i }).click()
await page.waitForTimeout(800)
await page.getByRole('button', { name: /^connect wallet$/i }).first().click()
await page.waitForTimeout(800)
// Force one failure
await page.getByRole('button', { name: /make the next transaction fail/i }).click().catch(() => {})
await page.getByRole('button', { name: /sign and file/i }).click()
await page.waitForTimeout(2500)
await page.screenshot({ path: path.join(OUT, `publish-failed-${W}.png`), fullPage: false })
const retry = page.getByRole('button', { name: /^retry/i })
console.log('retry visible', await retry.isVisible().catch(() => false))
if (await retry.isVisible().catch(() => false)) await retry.click()
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(1500)
  const md = page.getByRole('button', { name: /mark done/i }).first()
  if (await md.isVisible().catch(() => false)) {
    if (i === 0) await page.screenshot({ path: path.join(OUT, `publish-manual-${W}.png`), fullPage: false })
    await md.click()
  }
}
await page.waitForTimeout(1500)
await page.screenshot({ path: path.join(OUT, `publish-done-${W}.png`), fullPage: false })
const open = page.getByRole('link', { name: /open the case file/i })
console.log('done link', await open.getAttribute('href').catch(() => null))
await browser.close()
