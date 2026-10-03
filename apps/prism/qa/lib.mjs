// Shared helpers for Pine Prism QA scripts (Playwright + Chromium).
import { chromium } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const OUT = join(here, '..', '.qa')
export const BASE = process.env.BASE ?? 'http://localhost:3004'

/** Launch Chromium. `webgl: false` adds --disable-webgl (no-WebGL emulation). */
export async function launch({ webgl = true } = {}) {
  await mkdir(OUT, { recursive: true })
  const args = webgl ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : ['--disable-webgl', '--disable-3d-apis']
  try {
    return await chromium.launch({ args })
  } catch (e) {
    const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), 'Library', 'Caches', 'ms-playwright')
    const dirs = existsSync(cache) ? (await readdir(cache)).filter((d) => d.startsWith('chromium')).sort().reverse() : []
    for (const d of dirs) {
      for (const sub of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-mac-arm64', 'chrome-linux64']) {
        for (const exe of [join(cache, d, sub, 'chrome-headless-shell'), join(cache, d, sub, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')]) {
          if (existsSync(exe)) return chromium.launch({ executablePath: exe, args })
        }
      }
    }
    throw e
  }
}

export async function newPage(browser, { mobile = false, reduced = false, video = false } = {}) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    permissions: ['clipboard-read', 'clipboard-write'],
    ...(video ? { recordVideo: { dir: join(OUT, 'video'), size: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 } } } : {}),
  })
  const page = await ctx.newPage()
  if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' })
  page.errors = []
  page.on('pageerror', (e) => page.errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    // Third-party wallet SDK telemetry noise without network access is not an app error.
    if (/walletconnect|Reown|pulse\.walletconnect|ERR_NAME_NOT_RESOLVED|Failed to load resource: net::ERR_/i.test(t)) return
    // The 404 page itself responds 404 by design.
    if (/status of 404/.test(t) && /no-such-page|pine-9999/.test(page.url())) return
    page.errors.push(t)
  })
  return page
}

export async function go(page, path, { wait = 700 } = {}) {
  await page.goto(BASE + path + (path.includes('?') ? '&' : '?') + 'qa=1', { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(wait)
}

export async function shot(page, name, full = false) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: full })
}

/** Horizontal overflow check: returns offending widths or null. */
export async function overflow(page) {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth
    const sw = document.documentElement.scrollWidth
    if (sw <= w + 1) return null
    const wide = []
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (r.right > w + 1 && r.width > 0 && getComputedStyle(el).position !== 'fixed') wide.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} → ${Math.round(r.right)}`)
      if (wide.length > 6) break
    }
    return { clientWidth: w, scrollWidth: sw, wide }
  })
}

export function log(...a) {
  console.log(...a)
}
