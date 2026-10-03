// Ad-hoc screenshot helper for review passes.
// Usage:
//   node qa/peek.mjs <path> [--vp=desktop|mobile] [--dark] [--sel=<css>] [--clip=x,y,w,h] [--full]
//                    [--do=<async js using `page`>] [--out=name] [--scroll=<css>] [--wait=ms] [--keep]
// Saves to .qa/peek/<out>.png and prints console errors + horizontal overflow.
import { chromium } from '@playwright/test'
import { mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const flag = (k) => args.includes(`--${k}`)
const target = args.find((a) => !a.startsWith('--')) ?? '/'
const base = (opt('base') ?? 'http://localhost:3001').replace(/\/$/, '')
const vpName = opt('vp') ?? 'desktop'
const vp = vpName === 'mobile' ? { width: 390, height: 844, isMobile: true } : { width: 1440, height: 900, isMobile: false }
const out = opt('out') ?? `${vpName}${flag('dark') ? '-dark' : ''}-${target.replace(/[^a-z0-9]+/gi, '_').slice(0, 60)}`

async function launch() {
  try {
    return await chromium.launch()
  } catch (e) {
    const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
    const dirs = existsSync(cache) ? (await readdir(cache)).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : []
    for (const d of dirs) {
      const exe = path.join(cache, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
      if (existsSync(exe)) return chromium.launch({ executablePath: exe })
    }
    throw e
  }
}

const browser = await launch()
const context = await browser.newContext({
  viewport: { width: vp.width, height: vp.height },
  isMobile: vp.isMobile,
  hasTouch: vp.isMobile,
  deviceScaleFactor: 1,
  colorScheme: flag('dark') ? 'dark' : 'light',
  reducedMotion: flag('motion') ? 'no-preference' : 'reduce',
  permissions: ['clipboard-read', 'clipboard-write'],
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`)
})
await page.goto(base + target, { waitUntil: 'domcontentloaded', timeout: 60000 })
try {
  await page.waitForLoadState('networkidle', { timeout: 6000 })
} catch {}
await page.waitForTimeout(Number(opt('wait') ?? 700))
if (opt('do')) {
  const fn = new Function('page', 'vp', `return (async () => { ${opt('do')} })()`)
  try {
    const r = await fn(page, vp)
    if (r !== undefined) console.log('do →', typeof r === 'string' ? r : JSON.stringify(r, null, 1))
  } catch (e) {
    console.log('do FAILED:', e.message.split('\n').slice(0, 3).join(' | '))
  }
  await page.waitForTimeout(400)
}
if (opt('scroll')) await page.locator(opt('scroll')).first().scrollIntoViewIfNeeded()
await mkdir(path.resolve(here, '../.qa/peek'), { recursive: true })
const file = path.resolve(here, '../.qa/peek', `${out}.png`)
if (opt('sel')) {
  await page.locator(opt('sel')).first().screenshot({ path: file })
} else if (opt('clip')) {
  const [x, y, width, height] = opt('clip').split(',').map(Number)
  await page.screenshot({ path: file, clip: { x, y, width, height }, fullPage: true })
} else {
  await page.screenshot({ path: file, fullPage: flag('full') })
}
const overflow = await page.evaluate((w) => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - w, vp.width)
if (overflow > 1) console.log(`HORIZONTAL OVERFLOW ${overflow}px`)
const errs = errors.filter((e) => !/Download the React DevTools|WalletConnect|Lit is in dev mode|reown|web3modal|HMR|Fast Refresh/i.test(e))
if (errs.length) console.log(errs.slice(0, 8).join('\n').slice(0, 2000))
console.log(file)
await browser.close()
