// Journey (h): keyboard-only board and composer. Logs the focus order and whether focus is visible.
import { launch, newPage, go, shot, log } from './lib.mjs'
const browser = await launch()
const page = await newPage(browser)
const desc = () =>
  page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return 'body'
    const cs = getComputedStyle(el)
    const visible = cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px' ? 'outline' : cs.boxShadow !== 'none' ? 'shadow' : 'NONE'
    const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 60)
    return `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[${el.getAttribute('role')}]` : ''} "${name}" focus:${visible}`
  })
await go(page, '/board')
const seen = []
for (let i = 0; i < 40; i++) {
  await page.keyboard.press('Tab')
  seen.push(await desc())
}
log('BOARD TAB ORDER\n' + seen.map((s, i) => `${i + 1}. ${s}`).join('\n'))
await shot(page, 'kb-board')
// open a tile with Enter
await page.keyboard.press('Enter')
await page.waitForTimeout(1500)
log('after Enter url:', page.url())

// composer by keyboard
await go(page, '/compose')
log('composer initial focus:', await desc())
await page.keyboard.type('kleros/gateway-balancer-bot/pull/47')
await page.waitForTimeout(1500)
await page.keyboard.press('Enter')
await page.waitForTimeout(1200)
log('after Enter in source:', await page.getByText('Pinned. This exact commit').count() ? 'pinned' : 'not pinned')
// tab to Continue
for (let i = 0; i < 25; i++) {
  await page.keyboard.press('Tab')
  const d = await desc()
  if (d.includes('Continue to policy')) break
}
await page.keyboard.press('Enter')
await page.waitForTimeout(600)
log('focus after stage change:', await desc())
// policy radios: tab into radiogroup and use arrows
for (let i = 0; i < 15; i++) {
  await page.keyboard.press('Tab')
  const d = await desc()
  if (d.includes('radio')) break
}
log('policy focus:', await desc())
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(200)
log('after ArrowRight:', await desc(), 'checked:', await page.evaluate(() => document.activeElement?.getAttribute('aria-checked')))
await page.keyboard.press('Space')
await page.waitForTimeout(300)
await shot(page, 'kb-policy')
log('errors', page.errors)
await browser.close()
