// Contact sheet of frames: node qa/sheet.mjs <prefix> [cols] [out]
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, OUT } from './lib.mjs'
const prefix = process.argv[2]
const cols = Number(process.argv[3] ?? 4)
const out = process.argv[4] ?? `sheet-${prefix}`
const files = (await readdir(OUT)).filter((f) => f.startsWith(prefix) && f.endsWith('.png')).sort()
const imgs = await Promise.all(files.map(async (f) => `data:image/png;base64,${(await readFile(join(OUT, f))).toString('base64')}`))
const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
await page.setContent(`<body style="margin:0;background:#000;display:grid;grid-template-columns:repeat(${cols},1fr);gap:4px">${imgs.map((src, i) => `<div style="position:relative"><img src="${src}" style="width:100%;display:block"><span style="position:absolute;left:6px;top:4px;color:#0f0;font:12px monospace">${files[i]}</span></div>`).join('')}</body>`)
await page.waitForTimeout(300)
await page.screenshot({ path: join(OUT, `${out}.png`), fullPage: true })
await browser.close()
console.log(`${out}.png from ${files.length} frames`)
