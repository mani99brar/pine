// Crop a region of a captured screen: node qa/crop.mjs <name> <y> <height> [x] [width] [scale]
// Writes .qa/crop-<name>-<y>.png. Useful for reading full-page captures at native resolution.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, OUT } from './lib.mjs'
const [name, y = '0', h = '900', x = '0', w = '0', scale = '1'] = process.argv.slice(2)
const buf = await readFile(join(OUT, `${name}.png`))
const width = buf.readUInt32BE(16)
const height = buf.readUInt32BE(20)
const W = Number(w) || width - Number(x)
const H = Math.min(Number(h), height - Number(y))
const browser = await launch({ webgl: false })
const page = await browser.newPage({ viewport: { width: Math.ceil(W * Number(scale)), height: Math.ceil(H * Number(scale)) } })
await page.setContent(`<body style="margin:0;overflow:hidden;background:#000"><img src="data:image/png;base64,${buf.toString('base64')}" style="position:absolute;left:${-Number(x) * Number(scale)}px;top:${-Number(y) * Number(scale)}px;width:${width * Number(scale)}px"></body>`)
await page.waitForTimeout(100)
const out = join(OUT, `crop-${name}-${y}${x !== '0' ? `-${x}` : ''}.png`)
await page.screenshot({ path: out })
await browser.close()
console.log(out, `${width}x${height}`)
