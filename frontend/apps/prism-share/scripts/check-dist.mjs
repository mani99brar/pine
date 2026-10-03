// Static checks on dist/ against the artifact limits:
// index.html present, ≤ 255 files, ≤ 16 MB per file, every asset URL relative (no "/_next", "/assets",
// url(/…)), no eval / new Function in the bundles, and no network origins besides Google Fonts in HTML/CSS.
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DIST = join(here, '..', 'dist')
const MAX_FILES = 255
const MAX_BYTES = 16 * 1024 * 1024

async function walk(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

const problems = []
const files = await walk(DIST).catch(() => [])
if (!files.length) {
  console.error('dist/ is missing: run `pnpm --filter @pine/app-prism-share build` first.')
  process.exit(1)
}
if (!files.some((f) => relative(DIST, f) === 'index.html')) problems.push('dist/index.html is missing')
if (files.length > MAX_FILES) problems.push(`${files.length} files (limit ${MAX_FILES})`)

let total = 0
const rows = []
for (const f of files) {
  const { size } = await stat(f)
  total += size
  rows.push([relative(DIST, f), size])
  if (size > MAX_BYTES) problems.push(`${relative(DIST, f)} is ${(size / 1048576).toFixed(1)} MB (limit 16 MB)`)
  if (!/\.(html|js|css)$/.test(f)) continue
  const text = await readFile(f, 'utf8')
  for (const [re, what] of [
    [/["'`(]\/_next\//, 'absolute /_next/ URL'],
    [/["'`(]\/assets\//, 'absolute /assets/ URL'],
    [/url\(\s*["']?\/(?!\/)/, 'absolute url(/…) in CSS'],
    [/\bnew Function\s*\(/, 'new Function()'],
    [/(^|[^.\w$])eval\s*\(/, 'eval()'],
  ]) {
    if (re.test(text)) problems.push(`${relative(DIST, f)}: ${what}`)
  }
  if (/\.(html|css)$/.test(f)) {
    // Resources the page would load: CSS url()/@import and HTML src/href (comments and xmlns are not requests).
    const loads = /\.css$/.test(f)
      ? [...text.matchAll(/(?:url\(\s*["']?|@import\s+["'])https?:\/\/([a-z0-9.-]+)/gi)]
      : [...text.matchAll(/(?:src|href)\s*=\s*["']https?:\/\/([a-z0-9.-]+)/gi)]
    for (const m of loads) {
      const host = m[1].toLowerCase()
      if (!['fonts.googleapis.com', 'fonts.gstatic.com'].includes(host)) problems.push(`${relative(DIST, f)}: loads from ${host}`)
    }
  }
}

rows.sort((a, b) => b[1] - a[1])
const kb = (n) => `${(n / 1024).toFixed(1)} kB`
console.log(`dist/: ${files.length} files, ${(total / 1048576).toFixed(2)} MB total; largest:`)
for (const [p, s] of rows.slice(0, 6)) console.log(`  ${kb(s).padStart(10)}  ${p}`)
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('\nOK: relative URLs only, no eval, within the artifact limits.')
