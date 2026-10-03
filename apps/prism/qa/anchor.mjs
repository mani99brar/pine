// Screenshot a page section: node qa/anchor.mjs /path sectionId name [--mobile]
import { launch, newPage, go, shot, log } from './lib.mjs'
const [path, id, name] = process.argv.slice(2)
const browser = await launch()
const page = await newPage(browser, { mobile: process.argv.includes('--mobile') })
await go(page, path, { wait: 1500 })
await page.evaluate((id) => document.getElementById(id)?.scrollIntoView({ block: 'start' }), id)
await page.waitForTimeout(900)
await shot(page, name)
log('errors', page.errors.slice(0, 4))
await browser.close()
