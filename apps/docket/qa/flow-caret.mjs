// Flow check: editing in the middle of a composer field keeps the caret in place.
import { chromium } from '@playwright/test'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
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
await page.goto(`${BASE}/file?qa=1`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: /start a new filing/i }).click()
await page.waitForURL(/\/file\/[^/?]+/)
const draftUrl = page.url().split('?')[0]
await page.goto(`${draftUrl}?step=claim`, { waitUntil: 'networkidle' })
const title = page.locator('#f-title')
await title.fill('Reporter deposits never draw reserves')
await page.waitForTimeout(800)
// Put the caret after "never " and type mid-text
await title.evaluate((el) => el.setSelectionRange(26, 26))
await title.type('X Y Z ', { delay: 30 })
console.log('title:', await title.inputValue())
const req = page.locator('#f-requirement')
await req.fill('Alpha omega.')
await page.waitForTimeout(700)
await req.evaluate((el) => el.setSelectionRange(6, 6))
await req.type('beta ', { delay: 30 })
console.log('requirement:', await req.inputValue())
await browser.close()
