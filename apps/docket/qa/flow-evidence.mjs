// Flow check: file a direct exhibit on an open claim with the simulated wallet.
import { chromium } from '@playwright/test'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.qa', 'peek')
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 300)))
await page.goto(`${BASE}/claims/pine-0009/evidence?qa=1`, { waitUntil: 'networkidle' })
// Try submitting empty to see the error summary
await page.getByRole('button', { name: /^connect wallet$/i }).first().click()
await page.waitForTimeout(600)
await page.getByRole('button', { name: /^file exhibit/i }).click()
await page.waitForTimeout(400)
console.log('errors shown:', await page.locator('#exhibit-errors').isVisible().catch(() => false))
await page.screenshot({ path: path.join(OUT, 'evidence-errors.png') })
await page.fill('#ex-title', 'Reporter top-up borrows from the arbitration allocation after a timeout')
await page.fill('#ex-summary', 'After a **timeout** during the bridging-fee read, the planner falls back to the pair allocation. See `test/repro.spec.ts`.')
await page.fill('#ex-expected', 'The top-up is skipped and reporter.underfunded is emitted.')
await page.fill('#ex-actual', 'A 4.2 xDAI deposit is planned with source = arbitration.')
const boxes = page.locator('input[id^="adm-"]')
const n = await boxes.count()
for (let i = 0; i < n; i++) await boxes.nth(i).check()
await page.getByRole('button', { name: /^file exhibit/i }).click()
await page.waitForTimeout(4000)
await page.screenshot({ path: path.join(OUT, 'evidence-done.png') })
console.log((await page.locator('main').innerText()).slice(0, 600).replace(/\n+/g, ' | '))
await page.goto(`${BASE}/claims/pine-0009#exhibits`, { waitUntil: 'networkidle' })
await page.waitForTimeout(1000)
console.log('exhibit C present:', await page.locator('#exhibit-c').count())
await browser.close()
