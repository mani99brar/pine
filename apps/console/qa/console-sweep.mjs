// Visits every route (signed out, then signed in with the demo identity and a connected demo wallet)
// and prints console errors, page errors and horizontal overflow per route.
import { chromium } from '@playwright/test'
const base = (process.argv[2] ?? 'http://localhost:3001').replace(/\/$/, '')
const ROUTES = ['/', '/claims', '/claims?view=mine', '/claims/pine-0009', '/claims/pine-0009?tab=market', '/claims/pine-0009?tab=evidence', '/claims/pine-0009?tab=oracle', '/claims/pine-0009?tab=agent', '/claims/pine-0009?tab=activity', '/claims/pine-0002', '/claims/pine-0005', '/claims/pine-0015', '/claims/pine-0016', '/claims/pine-0009/evidence/new', '/new', '/drafts', '/dashboard', '/settings', '/repos', '/repos/kleros/gateway-balancer-bot', '/repos/kleros/gateway-balancer-bot/pull/47', '/policies', '/policies/BOT-001', '/policies/SC-001', '/activity', '/agents', '/risks', '/nope']
const IGNORE = /Download the React DevTools|WalletConnect|reown|web3modal|Lit is in dev|404 \(Not Found\)|Fast Refresh|HMR|scroll-behavior/i
const browser = await chromium.launch()
for (const signedIn of [false, true]) {
  for (const vp of [{ w: 1440, h: 900, m: false }, { w: 390, h: 844, m: true }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: vp.m, hasTouch: vp.m })
    const page = await ctx.newPage()
    if (signedIn) {
      await page.goto(base + '/settings', { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /Use the demo GitHub identity/ }).click()
      await page.waitForSelector('text=Sign out', { timeout: 20000 })
      await page.getByRole('button', { name: /Connect (demo )?wallet/ }).first().click().catch(() => {})
      await page.waitForTimeout(500)
    }
    for (const r of ROUTES) {
      const errs = []
      const onErr = (e) => errs.push(`pageerror ${e.message.split('\n')[0]}`)
      const onCon = (m) => {
        if ((m.type() === 'error' || m.type() === 'warning') && !IGNORE.test(m.text())) errs.push(`${m.type()} ${m.text().split('\n')[0].slice(0, 160)}`)
      }
      page.on('pageerror', onErr)
      page.on('console', onCon)
      await page.goto(base + r, { waitUntil: 'domcontentloaded' })
      try { await page.waitForLoadState('networkidle', { timeout: 4000 }) } catch {}
      await page.waitForTimeout(500)
      const overflow = await page.evaluate((w) => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - w, vp.w)
      if (overflow > 1) errs.push(`overflow ${overflow}px`)
      if (errs.length) console.log(`${signedIn ? 'in ' : 'out'} ${vp.w} ${r}: ${[...new Set(errs)].join(' || ')}`)
      page.off('pageerror', onErr)
      page.off('console', onCon)
    }
    await ctx.close()
  }
}
await browser.close()
console.log('sweep done')
