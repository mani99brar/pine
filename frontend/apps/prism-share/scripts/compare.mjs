// Pixel comparison of the static build against the live Next app (`pnpm --filter @pine/app-prism start`, port 3004).
//
//   node scripts/compare.mjs            desktop 1440×900
//   node scripts/compare.mjs --mobile   390×844
//
// Both sides run with prefers-reduced-motion (the hero shows its final poster, routes do not animate) so
// the captures are deterministic. In the static build the one extra demo-banner line is hidden for the
// capture (it is the only intended difference). Writes static/live/diff PNGs and compare-<tag>.json to $QA_DIR.
import { chromium } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './serve.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const mobile = process.argv.includes('--mobile')
const tag = mobile ? 'm' : 'd'
const OUT = process.env.QA_DIR ?? join(here, '..', '.qa')
const LIVE = process.env.LIVE ?? 'http://localhost:3004'
const PORT = Number(process.env.PORT ?? 4173)
const BASE = '/a/b/c/'
await mkdir(join(OUT, 'compare'), { recursive: true })

const ROUTES = [
  ['landing', '/'],
  ['table', '/claims'],
  ['table-list', '/claims?view=list'],
  ['claim-open', '/claims/pine-0009'],
  ['claim-yes', '/claims/pine-0002'],
  ['claim-arbitration', '/claims/pine-0005'],
  ['claim-publishing', '/claims/pine-0015'],
  ['claim-missing', '/claims/pine-9999'],
  ['evidence', '/claims/pine-0009/evidence'],
  ['compose', '/compose'],
  ['drafts', '/drafts'],
  ['dashboard', '/dashboard'],
  ['account', '/account'],
  ['activity', '/activity'],
  ['repos', '/repos'],
  ['repo', '/repos/kleros/gateway-balancer-bot?pr=47'],
  ['policies', '/policies'],
  ['policy', '/policies/BOT-001'],
  ['agents', '/agents'],
  ['risks', '/risks'],
  ['not-found', '/no-such-page'],
]

const server = await startServer({ port: PORT, base: BASE })
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const ctxOpts = { viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'reduce' }
const liveCtx = await browser.newContext(ctxOpts)
const staticCtx = await browser.newContext(ctxOpts)
const live = await liveCtx.newPage()
const stat = await staticCtx.newPage()
const differ = await (await browser.newContext()).newPage()

const HIDE_EXTRA_LINE = `.ps-banner > .ps-banner-line{display:none!important}.ps-banner > :first-child:not(.ps-banner-line){border-bottom-color:var(--edge)!important}`
const SETTLE = `*,*::before,*::after{caret-color:transparent!important}`

async function captureLive(route, file) {
  const [p, hash] = route.split('#')
  await live.goto(`${LIVE}${p}${hash ? `#${hash}` : ''}`, { waitUntil: 'networkidle' })
  await live.addStyleTag({ content: SETTLE })
  await live.waitForTimeout(1800)
  await live.screenshot({ path: file })
}

async function captureStatic(route, file) {
  await stat.goto(`http://localhost:${PORT}/host.html?route=${encodeURIComponent(route)}`, { waitUntil: 'load' })
  const f = stat.frames().find((fr) => fr.url().includes(BASE))
  await f.waitForSelector('main#main')
  await f.addStyleTag({ content: HIDE_EXTRA_LINE + SETTLE })
  await stat.waitForTimeout(1800)
  await stat.screenshot({ path: file })
}

/** Percent of pixels whose max channel delta exceeds 40, plus a diff image (changed pixels in red). */
async function diff(a, b, outFile) {
  const [da, db] = await Promise.all([readFile(a), readFile(b)])
  const res = await differ.evaluate(
    async ({ a, b }) => {
      const load = (src) =>
        new Promise((r) => {
          const i = new Image()
          i.onload = () => r(i)
          i.src = src
        })
      const [ia, ib] = await Promise.all([load(a), load(b)])
      const w = Math.min(ia.width, ib.width)
      const h = Math.min(ia.height, ib.height)
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const x = c.getContext('2d')
      x.drawImage(ia, 0, 0)
      const pa = x.getImageData(0, 0, w, h).data
      x.clearRect(0, 0, w, h)
      x.drawImage(ib, 0, 0)
      const pb = x.getImageData(0, 0, w, h)
      const out = x.createImageData(w, h)
      let changed = 0
      for (let i = 0; i < pa.length; i += 4) {
        const d = Math.max(Math.abs(pa[i] - pb.data[i]), Math.abs(pa[i + 1] - pb.data[i + 1]), Math.abs(pa[i + 2] - pb.data[i + 2]))
        const g = (pb.data[i] + pb.data[i + 1] + pb.data[i + 2]) / 9
        if (d > 40) {
          changed++
          out.data.set([255, 40, 60, 255], i)
        } else out.data.set([g, g, g, 255], i)
      }
      x.putImageData(out, 0, 0)
      return { percent: (changed / (w * h)) * 100, png: c.toDataURL('image/png') }
    },
    { a: `data:image/png;base64,${da.toString('base64')}`, b: `data:image/png;base64,${db.toString('base64')}` },
  )
  await writeFile(outFile, Buffer.from(res.png.split(',')[1], 'base64'))
  return Math.round(res.percent * 100) / 100
}

const report = []
for (const [name, route] of ROUTES) {
  const s = join(OUT, 'compare', `${tag}-${name}-static.png`)
  const l = join(OUT, 'compare', `${tag}-${name}-live.png`)
  try {
    await captureLive(route, l)
    await captureStatic(route, s)
    const pct = await diff(s, l, join(OUT, 'compare', `${tag}-${name}-diff.png`))
    report.push({ name, route, diffPercent: pct })
    console.log(`${pct < 1 ? '✓' : pct < 4 ? '~' : '!'} ${name.padEnd(18)} ${pct.toFixed(2)}% pixels differ`)
  } catch (e) {
    report.push({ name, route, error: String(e).slice(0, 300) })
    console.log(`✗ ${name}: ${String(e).split('\n')[0]}`)
  }
}
await writeFile(join(OUT, `compare-${tag}.json`), JSON.stringify(report, null, 2))
await browser.close()
server.close()
