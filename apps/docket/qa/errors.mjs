// Print page errors and console errors for the given paths.
// Usage: node qa/errors.mjs / /docket /claims/pine-0009
import { chromium } from '@playwright/test'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
function launchOptions() {
  try {
    if (existsSync(chromium.executablePath())) return {}
  } catch {
    /* fall through */
  }
  const dir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
  for (const entry of existsSync(dir) ? readdirSync(dir).sort().reverse() : []) {
    const c = path.join(dir, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
    if (existsSync(c)) return { executablePath: c }
  }
  return {}
}
const browser = await chromium.launch(launchOptions())
const page = await browser.newPage()
for (const route of process.argv.slice(2)) {
  const errs = []
  const onErr = (e) => errs.push(`pageerror: ${e.message.split('\n').slice(0, 12).join('\n')}`)
  const onConsole = (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errs.push(`${m.type()}: ${m.text().split('\n').slice(0, 30).join('\n')}`)
  }
  page.on('pageerror', onErr)
  page.on('console', onConsole)
  await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' }).catch(() => {})
  await page.waitForTimeout(1500)
  console.log(`== ${route}: ${errs.length} issue(s)`)
  for (const e of errs) console.log(e.slice(0, 3000))
  page.off('pageerror', onErr)
  page.off('console', onConsole)
}
await browser.close()
