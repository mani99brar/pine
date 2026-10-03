// Keyboard-only check: the review acknowledgements, the publish button and the menu, without a mouse.
// Usage: node qa/flow-keyboard.mjs
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const active = () =>
  page.evaluate(() => {
    const el = document.activeElement
    if (!el) return 'none'
    const label = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : ''
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}: ${(label || el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 50)}`
  })
await page.goto(`${BASE}/file?qa=1`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: /worked example/i }).click()
await page.waitForURL(/\/file\/[^/?]+/)
await page.getByRole('button', { name: /^pin this commit$/i }).first().click({ timeout: 15000 })
await page.waitForTimeout(600)
const draftUrl = page.url().split('?')[0]
await page.goto(`${draftUrl}?step=review`, { waitUntil: 'networkidle' })
await page.waitForTimeout(600)
// Tab until the first acknowledgement, then tick all six with Space.
let ticks = 0
for (let i = 0; i < 160 && ticks < 6; i++) {
  await page.keyboard.press('Tab')
  const a = await active()
  if (a.startsWith('input#ack-')) {
    if (ticks === 0) {
      await page.waitForTimeout(700)
      await page.screenshot({ path: path.join(OUT, 'kbd-ack-focus.png') })
    }
    await page.keyboard.press('Space')
    ticks++
  }
}
console.log('acks ticked by keyboard:', ticks)
for (let i = 0; i < 20; i++) {
  await page.keyboard.press('Tab')
  const a = await active()
  if (/continue: publish/i.test(a)) {
    console.log('reached:', a)
    await page.screenshot({ path: path.join(OUT, 'kbd-continue-focus.png') })
    await page.keyboard.press('Enter')
    break
  }
}
await page.waitForTimeout(800)
console.log('now at', page.url().split('step=')[1])
console.log('focused after step change:', await active())
await browser.close()
