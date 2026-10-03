import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Pine Prism as a static, browser-only SPA.
 *
 * Prism's own source (apps/prism/src) is imported as-is through the `@/` alias. Next.js and next-auth
 * entry points are replaced with small browser shims (src/shims), and the app's API routes are served
 * in the browser by a fetch interceptor (src/api). Everything is emitted with relative URLs (`base: './'`)
 * so the build works from any nested path on any origin.
 */

const here = dirname(fileURLToPath(import.meta.url))
const prismSrc = resolve(here, '../prism/src')
const packages = resolve(here, '../../packages')
const shim = (f: string) => resolve(here, 'src/shims', f)

/** Demo-mode environment, inlined exactly like Next inlines NEXT_PUBLIC_* variables. */
const ENV: Record<string, string> = {
  NEXT_PUBLIC_PINE_DATA_SOURCE: 'mock',
  NEXT_PUBLIC_PINE_DEMO_WALLET: '1',
  NEXT_PUBLIC_PINE_MOCK_LATENCY: '1',
  NEXT_PUBLIC_CHAIN_ID: '100',
  // Neutral, reserved documentation domain (RFC 2606): agent briefs and curl snippets show it as a placeholder.
  NEXT_PUBLIC_SITE_URL: 'https://pine-prism.example',
  NEXT_PUBLIC_PINE_SITE_URL: 'https://pine-prism.example',
  // Not a secret: the in-browser handlers only need a value so they skip the "dev secret" warning.
  AUTH_SECRET: 'pine-prism-static-preview-not-a-secret',
}

const define: Record<string, string> = {
  'process.env.NODE_ENV': JSON.stringify('production'),
}
for (const [k, v] of Object.entries(ENV)) define[`process.env.${k}`] = JSON.stringify(v)
// Read but intentionally unset in the static preview.
for (const k of [
  'NEXT_PUBLIC_PINE_API_URL',
  'NEXT_PUBLIC_ENVIO_GRAPHQL_URL',
  'NEXT_PUBLIC_IPFS_GATEWAY',
  'NEXT_PUBLIC_PINE_GITHUB_OAUTH',
  'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID',
  'NEXT_PUBLIC_RPC_URL_1',
  'NEXT_PUBLIC_RPC_URL_100',
  'NEXT_PUBLIC_RPC_URL_11155111',
  'PINE_IPFS_UPLOAD_URL',
  'PINE_IPFS_UPLOAD_TOKEN',
  'PINE_GITHUB_SOURCE',
  'PINE_API_TOKEN',
  'AUTH_GITHUB_ID',
  'AUTH_GITHUB_SECRET',
  'AUTH_URL',
  'NEXTAUTH_URL',
  'NEXTAUTH_SECRET',
  'VERCEL_URL',
  'VITEST',
]) {
  define[`process.env.${k}`] = 'undefined'
}

/**
 * Import redirections that depend on the importer (relative specifiers inside Prism and @pine/react),
 * which `resolve.alias` cannot express.
 */
/**
 * The artifact host rejects files containing a literal U+FFFD. micromark uses it on purpose (as the
 * substitute for invalid characters) inside template literals; the escape sequence is equivalent there.
 */
function escapeReplacementChar(): Plugin {
  return {
    name: 'prism-share:escape-replacement-char',
    apply: 'build',
    // After minification: the minifier would turn the escape back into the literal character.
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk' && file.code.includes('\uFFFD')) file.code = file.code.replaceAll('\uFFFD', '\\uFFFD')
      }
    },
  }
}

function prismOverrides(): Plugin {
  const layout = resolve(prismSrc, 'app/layout.tsx')
  const providersIndex = resolve(packages, 'react/src/providers/index.tsx')
  return {
    name: 'prism-share:overrides',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null
      const from = importer.split('?')[0]
      // Root layout's stylesheet: wrapped so Tailwind also scans apps/prism/src and the fonts are declared.
      if (source === './globals.css' && from === layout) return resolve(here, 'src/styles.css')
      // wagmi config without connectors or RPC transports (demo mode never needs them).
      if (source === './wagmi-config' && from === providersIndex) return shim('wagmi-config.ts')
      // Prism and @pine/react link different pnpm variants of the same RainbowKit release. Resolve every
      // RainbowKit import from @pine/react's location: one copy in the bundle, and one wagmi context in dev
      // (Vite's dep optimizer keys prebundles by package name and would otherwise mix the variants).
      if (/^@rainbow-me\/rainbowkit(\/|$)/.test(source) && from !== providersIndex) {
        return this.resolve(source, providersIndex, { skipSelf: true })
      }
      return null
    },
  }
}

export default defineConfig({
  root: here,
  base: './',
  plugins: [prismOverrides(), react(), tailwindcss(), escapeReplacementChar()],
  define,
  resolve: {
    alias: [
      // Next.js and next-auth entry points → browser shims.
      { find: /^next\/link$/, replacement: shim('next-link.tsx') },
      { find: /^next\/navigation$/, replacement: shim('next-navigation.ts') },
      { find: /^next\/dynamic$/, replacement: shim('next-dynamic.tsx') },
      { find: /^next\/font\/google$/, replacement: shim('next-font-google.ts') },
      { find: /^next\/og$/, replacement: shim('empty.ts') },
      { find: /^next\/headers$/, replacement: shim('empty.ts') },
      { find: /^next\/server$/, replacement: shim('next-server.ts') },
      { find: /^server-only$/, replacement: shim('empty.ts') },
      { find: /^next-auth\/react$/, replacement: shim('next-auth-react.tsx') },
      // @pine/react with one override (account export without a download navigation).
      { find: /^@pine\/react$/, replacement: shim('pine-react.ts') },
      { find: /^@pine-real\/react$/, replacement: resolve(packages, 'react/src/index.ts') },
      // Pure helpers from @pine/server that are not exported as a subpath.
      { find: /^@pine-server-src\/(.*)$/, replacement: `${resolve(packages, 'server/src')}/$1` },
      // The demo banner gains one line about the static preview.
      { find: /^@\/components\/shell\/DemoBanner$/, replacement: shim('DemoBanner.tsx') },
      // Unshimmed access to Prism's source (used by the shims that wrap a Prism module).
      { find: /^@prism\/(.*)$/, replacement: `${prismSrc}/$1` },
      // Prism's own path alias.
      { find: /^@\/(.*)$/, replacement: `${prismSrc}/$1` },
    ],
    dedupe: ['react', 'react-dom', 'sonner'],
  },
  server: {
    fs: { allow: [resolve(here, '../..')] },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    // Fewer, larger files: the artifact allows 255 files.
    assetsInlineLimit: 8192,
  },
})
