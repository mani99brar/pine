// Shared helpers for Field QA journey scripts.
import { chromium } from '@playwright/test'
import { existsSync } from 'node:fs'
import { readdir, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const OUT = join(here, '..', '.qa')
export const BASE = process.env.BASE ?? 'http://localhost:3003'

export async function launch() {
  await mkdir(OUT, { recursive: true })
  try {
    return await chromium.launch()
  } catch (e) {
    const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), 'Library', 'Caches', 'ms-playwright')
    const dirs = existsSync(cache) ? (await readdir(cache)).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : []
    for (const d of dirs) {
      for (const sub of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-linux64']) {
        const exe = join(cache, d, sub, 'chrome-headless-shell')
        if (existsSync(exe)) return chromium.launch({ executablePath: exe })
      }
    }
    throw e
  }
}

export async function newPage(browser, { mobile = false, dark = false, reduced = true } = {}) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: dark ? 'dark' : 'light',
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await ctx.newPage()
  page.errors = []
  page.on('pageerror', (e) => page.errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && page.errors.push(m.text()))
  return page
}

export async function go(page, path) {
  await page.goto(BASE + path + (path.includes('?') ? '&' : '?') + 'qa=1', { waitUntil: 'networkidle', timeout: 45000 })
  await page.waitForTimeout(600)
}

export async function shot(page, name, full = false) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: full })
}

export function log(...a) {
  console.log(...a)
}
