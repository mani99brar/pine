// Flow check: redeem a winning position on a resolved claim with the simulated wallet.
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
await page.goto(`${BASE}/claims/pine-0002?qa=1`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: /^connect wallet$/i }).first().click()
await page.waitForTimeout(1200)
await page.locator('#position').scrollIntoViewIfNeeded()
await page.waitForTimeout(500)
await page.locator('#position').screenshot({ path: path.join(OUT, 'redeem-before.png') })
const btn = page.locator('#position').getByRole('button', { name: /^redeem$/i })
console.log('redeem visible', await btn.isVisible().catch(() => false))
await btn.click().catch(() => {})
await page.waitForTimeout(3000)
await page.locator('#position').screenshot({ path: path.join(OUT, 'redeem-after.png') })
console.log((await page.locator('#position').innerText()).slice(-400).replace(/\n+/g, ' | '))
await browser.close()
