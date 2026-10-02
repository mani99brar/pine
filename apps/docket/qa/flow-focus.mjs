// Keyboard check: tab through the header and a claim page; screenshot the focus ring.
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
const page = await browser.newPage({ viewport: { width: 1440, height: 700 } })
await page.goto(`${BASE}/claims/pine-0009`, { waitUntil: 'networkidle' })
const seen = []
for (let i = 0; i < 14; i++) {
  await page.keyboard.press('Tab')
  seen.push(await page.evaluate(() => {
    const el = document.activeElement
    return el ? `${el.tagName.toLowerCase()}: ${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40)}` : 'none'
  }))
  if (i === 1) await page.screenshot({ path: path.join(OUT, 'focus-1.png') })
  if (i === 12) await page.screenshot({ path: path.join(OUT, 'focus-2.png') })
}
console.log(seen.join('\n'))
await browser.close()
