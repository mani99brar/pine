// Night-theme pass over key pages (viewport shots, plus a scrolled shot).
import { launch, newPage, go, shot, log } from './lib.mjs'
const browser = await launch()
const pages = [
  ['landing', '/'],
  ['board', '/board'],
  ['board-map', '/board?view=map'],
  ['claim', '/claims/pine-0009'],
  ['claim-disputed', '/claims/pine-0006'],
  ['claim-hostile', '/claims/pine-0010'],
  ['policy', '/policies/SC-001'],
  ['dashboard', '/dashboard'],
  ['account', '/account'],
  ['evidence', '/claims/pine-0009/evidence'],
  ['activity', '/activity'],
  ['agents', '/agents'],
  ['risks', '/risks'],
  ['404', '/nope'],
]
const filter = process.argv[2]
for (const mobile of [false, true]) {
  const page = await newPage(browser, { mobile, dark: true })
  for (const [name, path] of pages) {
    if (filter && !name.includes(filter)) continue
    await go(page, path)
    await shot(page, `night-${name}-${mobile ? 'm' : 'd'}-1`)
    await page.evaluate(() => window.scrollTo(0, window.innerHeight * 1.1))
    await page.waitForTimeout(400)
    await shot(page, `night-${name}-${mobile ? 'm' : 'd'}-2`)
  }
  log(mobile ? 'mobile' : 'desktop', 'errors', page.errors.slice(0, 3))
  await page.context().close()
}
await browser.close()
