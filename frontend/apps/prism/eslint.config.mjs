import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

// apps/prism and @pine/react resolve DIFFERENT copies of wagmi (and of RainbowKit, which binds to its own wagmi). A wagmi
// hook imported here looks for the app copy's WagmiProvider, finds none (the provider is @pine/react's), and crashes
// every prerender. Hooks and components that touch wagmi state must come from @pine/react.
const WAGMI_MESSAGE =
  "Import wallet hooks from '@pine/react', not wagmi: apps/prism resolves a different wagmi copy than the WagmiProvider in @pine/react, so a hook from here finds no provider and breaks the build (prerender)."
const RAINBOWKIT_MESSAGE =
  "RainbowKit hooks and components bind to the app's own wagmi copy, not the WagmiProvider in @pine/react: use '@pine/react'. Only the pure 'darkTheme' and '@rainbow-me/rainbowkit/styles.css' may be imported here."

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'qa/**'] },
  {
    files: ['src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'wagmi', message: WAGMI_MESSAGE },
            { name: '@rainbow-me/rainbowkit', allowImportNames: ['darkTheme'], message: RAINBOWKIT_MESSAGE },
          ],
          patterns: [
            { group: ['wagmi/*'], message: WAGMI_MESSAGE },
            { group: ['@rainbow-me/rainbowkit/*', '!@rainbow-me/rainbowkit/styles.css'], message: RAINBOWKIT_MESSAGE },
          ],
        },
      ],
    },
  },
]

export default config
