// Keyboard-only walk: node qa/keys.mjs <path> [tabs] [--mobile] [--shots=3,8,12]
// Logs each focused element (role, name, visible focus ring) and captures the listed tab stops.
import { launch, newPage, go, shot, log } from './lib.mjs'
const args = process.argv.slice(2)
const path = args.find((a) => a.startsWith('/')) ?? '/'
const tabs = Number(args.find((a) => /^\d+$/.test(a)) ?? 40)
const shots = new Set((args.find((a) => a.startsWith('--shots=')) ?? '--shots=').split('=')[1].split(',').filter(Boolean).map(Number))
const browser = await launch({ webgl: false })
const page = await newPage(browser, { mobile: args.includes('--mobile') })
await go(page, path, { wait: 1500 })
const name = path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'
for (let i = 1; i <= tabs; i++) {
  await page.keyboard.press('Tab')
  await page.waitForTimeout(120)
  const info = await page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return { tag: 'body' }
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || /rgb/.test(cs.boxShadow)
    const label = el.getAttribute('aria-label') || el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 70) || el.getAttribute('placeholder') || ''
    return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') ?? '', label, ring, inView: r.bottom > 0 && r.top < innerHeight && r.width > 0, y: Math.round(r.top) }
  })
  log(`${String(i).padStart(3)} ${info.tag}${info.role ? `[${info.role}]` : ''} ${info.ring ? 'ring' : 'NO-RING'} ${info.inView ? '' : 'OFFSCREEN '}${info.label ?? ''}`)
  if (shots.has(i)) await shot(page, `k-${name}-${i}`)
}
log('errors', page.errors.slice(0, 4))
await browser.close()
