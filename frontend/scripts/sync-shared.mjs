#!/usr/bin/env node
// Vendors the backend's frozen @pine/shared modules that the browser needs into @pine/core/pine-shared.
//
// The backend proposes every transaction as a plan; the client must re-verify each plan with its OWN copy of
// packages/shared/src/tx-plan.ts before any wallet prompt (see that file's header). This workspace is installed and
// released independently of the backend, so the copy lives here, byte-identical except for:
//   - relative import specifiers lose their `.js` extension (this workspace resolves TypeScript sources directly);
//   - `canonical.ts` is NOT copied: packages/core/src/pine-shared/canonical.ts is a browser-safe implementation
//     (no node:crypto, Buffer, canonicalize or multiformats), checked against the original by
//     packages/core/test/pine-shared.test.ts.
//
// Usage (from frontend/):
//   node scripts/sync-shared.mjs          rewrite the copies from ../packages/shared/src
//   node scripts/sync-shared.mjs --check  exit 1 when a copy differs from its source (CI)

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = resolve(here, '../../packages/shared/src')
const target = resolve(here, '../packages/core/src/pine-shared')

/** Files copied verbatim (modulo import specifiers). canonical.ts is deliberately absent. */
export const VENDORED = [
  'types.ts',
  'deployment.ts',
  'tx-plan.ts',
  'evidence.ts',
  'question.ts',
  'claim-document.ts',
  'abi/generated.ts',
  'abi/external.ts',
  'abi/algebra.ts',
]

const BANNER =
  '// VENDORED from packages/shared/src by frontend/scripts/sync-shared.mjs. Do not edit: change the original and re-run\n' +
  '// the script (CI runs it with --check).\n'

/** The vendored text for one source file. */
export function transform(text) {
  return BANNER + text.replace(/(from\s+["'])(\.{1,2}\/[^"']+?)\.js(["'])/g, '$1$2$3')
}

function main() {
  const check = process.argv.includes('--check')
  if (!existsSync(source)) {
    console.error(`sync-shared: ${source} not found (run from a full repository checkout)`)
    process.exit(2)
  }
  const stale = []
  for (const file of VENDORED) {
    const expected = transform(readFileSync(join(source, file), 'utf8'))
    const out = join(target, file)
    const actual = existsSync(out) ? readFileSync(out, 'utf8') : null
    if (actual === expected) continue
    if (check) {
      stale.push(file)
      continue
    }
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, expected)
    console.log(`sync-shared: wrote pine-shared/${file}`)
  }
  if (check && stale.length > 0) {
    console.error(`sync-shared: out of date: ${stale.join(', ')}. Run: node scripts/sync-shared.mjs`)
    process.exit(1)
  }
  if (check) console.log(`sync-shared: ${VENDORED.length} files match packages/shared/src`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
