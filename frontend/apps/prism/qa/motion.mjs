// Records frame sequences of motion moments: node qa/motion.mjs [hero|story|fracture|composer] [--mobile]
import { launch, newPage, go, shot, log, BASE } from './lib.mjs'
const which = process.argv[2] ?? 'hero'
const mobile = process.argv.includes('--mobile')
const browser = await launch()
const page = await newPage(browser, { mobile })
const frames = async (prefix, n, gap) => {
  for (let i = 0; i < n; i++) {
    await shot(page, `${prefix}-${String(i).padStart(2, '0')}`)
    await page.waitForTimeout(gap)
  }
}
if (which === 'hero') {
  await page.goto(BASE + '/?qa=1', { waitUntil: 'domcontentloaded' })
  await frames(`m-hero${mobile ? '-m' : ''}`, 12, 450)
  log('fps', await page.evaluate(() => new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(n) }; requestAnimationFrame(f) })))
} else if (which === 'story') {
  await go(page, '/')
  const steps = await page.locator('[data-step]').count()
  for (let i = 0; i < steps; i++) {
    await page.locator(`[data-step="${i}"]`).scrollIntoViewIfNeeded()
    await page.evaluate((i) => { const el = document.querySelector(`[data-step="${i}"]`); window.scrollBy(0, el.getBoundingClientRect().top - window.innerHeight * 0.45) }, i)
    await page.waitForTimeout(900)
    await shot(page, `m-story-${i}`)
  }
} else if (which === 'fracture') {
  await page.goto(BASE + '/claims/pine-0002?qa=1', { waitUntil: 'domcontentloaded' })
  // Start the frames when the claim's crystal mounts, so the sequence covers crack, burst and parting.
  await page.locator('header svg[role="img"]').first().waitFor({ timeout: 30000 })
  await frames('m-fracture', 10, 140)
}
log('errors', page.errors.slice(0, 5))
await browser.close()
