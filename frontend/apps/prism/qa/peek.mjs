// Quick look: node qa/peek.mjs /path [name] [--mobile] [--reduced] [--nowebgl] [--full] [--wait=ms]
import { launch, newPage, go, shot, log, overflow } from './lib.mjs'
const args = process.argv.slice(2)
const path = args.find((a) => a.startsWith('/')) ?? '/'
const name = args.find((a) => !a.startsWith('/') && !a.startsWith('--')) ?? 'peek'
const wait = Number((args.find((a) => a.startsWith('--wait=')) ?? '--wait=1200').split('=')[1])
const browser = await launch({ webgl: !args.includes('--nowebgl') })
const page = await newPage(browser, { mobile: args.includes('--mobile'), reduced: args.includes('--reduced') })
await go(page, path, { wait })
await shot(page, name, args.includes('--full'))
log('overflow', JSON.stringify(await overflow(page)))
log('errors', page.errors.slice(0, 8))
await browser.close()
