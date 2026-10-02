// Viewport-sized screenshots of one URL at several scroll offsets, for close inspection.
// Usage: node qa/peek.mjs <path> [width=1440] [height=900] [offsets=0] [name=peek]
//   offsets: comma-separated pixel offsets, or "all" for every viewport-height step.
import { chromium } from '@playwright/test'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE_URL ?? 'http://localhost:3002'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.qa', 'peek')
const [route = '/', w = '1440', h = '900', offsets = '0', name = 'peek', media = 'screen'] = process.argv.slice(2)

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

await mkdir(OUT, { recursive: true })
const browser = await chromium.launch(launchOptions())
const ctx = await browser.newContext({ viewport: { width: Number(w), height: Number(h) }, reducedMotion: 'reduce' })
const page = await ctx.newPage()
if (media === 'print') await page.emulateMedia({ media: 'print' })
if (route.startsWith('wizard:')) {
  // wizard:<step> → create the worked-example draft, pin the PR head commit, open that step
  await page.goto(`${BASE}/file?qa=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.getByRole('button', { name: /worked example/i }).click()
  await page.waitForURL(/\/file\/[^/?]+/, { timeout: 20000 })
  const pin = page.getByRole('button', { name: /^pin this commit$/i }).first()
  await pin.waitFor({ timeout: 15000 }).catch(() => {})
  if (await pin.isVisible().catch(() => false)) await pin.click()
  await page.waitForTimeout(900)
  const draftUrl = page.url().split('?')[0]
  await page.goto(`${draftUrl}?step=${route.slice(7)}`, { waitUntil: 'domcontentloaded' })
} else {
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' })
}
await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
await page.waitForTimeout(800)
const total = await page.evaluate(() => document.documentElement.scrollHeight)
if (offsets.startsWith('sel:')) {
  await page.locator(offsets.slice(4)).first().evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(500)
  const file = path.join(OUT, `${name}-sel.png`)
  await page.screenshot({ path: file })
  console.log(file)
  await browser.close()
  process.exit(0)
}
if (offsets === 'here') {
  // keep the scroll position the page chose (e.g. a #hash target)
  const file = path.join(OUT, `${name}-here.png`)
  await page.screenshot({ path: file })
  console.log(file)
  await browser.close()
  process.exit(0)
}
const list =
  offsets === 'all'
    ? Array.from({ length: Math.ceil(total / Number(h)) }, (_, i) => i * Number(h))
    : offsets.split(',').map(Number)
for (const y of list) {
  await page.evaluate((yy) => window.scrollTo(0, yy), y)
  await page.waitForTimeout(250)
  const file = path.join(OUT, `${name}-${y}.png`)
  await page.screenshot({ path: file })
  console.log(file)
}
console.log('page height', total)
await browser.close()
