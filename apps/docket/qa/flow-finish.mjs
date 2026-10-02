// Flow check: finish a partially published claim with the simulated wallet.
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
await page.goto(`${BASE}/claims/pine-0015?qa=1`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: /connect wallet/i }).first().click()
await page.waitForTimeout(800)
await page.locator('#filing').scrollIntoViewIfNeeded()
const btn = page.locator('#filing').getByRole('button', { name: /finish filing/i })
console.log('finish button visible', await btn.isVisible().catch(() => false))
await btn.click().catch((e) => console.log('click failed', e.message))
await page.waitForTimeout(3000)
await page.locator('#filing').screenshot({ path: path.join(OUT, 'finish-1.png') })
const markDone = page.getByRole('button', { name: /mark done/i }).first()
if (await markDone.isVisible().catch(() => false)) {
  await markDone.click()
  await page.waitForTimeout(2000)
}
const markDone2 = page.getByRole('button', { name: /mark done/i }).first()
if (await markDone2.isVisible().catch(() => false)) {
  await markDone2.click()
  await page.waitForTimeout(2000)
}
await page.locator('#filing').screenshot({ path: path.join(OUT, 'finish-2.png') }).catch(() => {})
console.log(await page.locator('#filing').innerText().catch(() => 'no #filing'))
await browser.close()
