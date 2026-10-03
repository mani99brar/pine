'use client'

import '@rainbow-me/rainbowkit/styles.css'
import type { ReactNode } from 'react'
import type { Session } from 'next-auth'
import { darkTheme } from '@rainbow-me/rainbowkit'
import { PineProviders, setDemoTxDelays } from '@pine/react'
import { MotionConfig } from 'motion/react'
import { Toaster } from 'sonner'

// Screenshot QA: `?qa=1` makes simulated demo transactions near-instant for this browser session.
if (typeof window !== 'undefined') {
  try {
    if (new URLSearchParams(window.location.search).has('qa')) sessionStorage.setItem('pine-prism:qa', '1')
    if (sessionStorage.getItem('pine-prism:qa') === '1') setDemoTxDelays({ signatureMs: 60, pendingMs: [90, 140], offchainMs: 60, switchMs: 60 })
  } catch {
    /* storage unavailable: keep realistic delays */
  }
}

const rainbowTheme = darkTheme({
  accentColor: '#f5ede4',
  accentColorForeground: '#16110f',
  borderRadius: 'small',
  fontStack: 'system',
  overlayBlur: 'small',
})

export function Providers({ children, session }: { children: ReactNode; session?: Session | null }) {
  return (
    <PineProviders appName="Pine Prism" session={session} rainbowTheme={rainbowTheme}>
      <MotionConfig reducedMotion="user" transition={{ type: 'spring', stiffness: 420, damping: 32 }}>
        {children}
        <Toaster
          position="bottom-right"
          theme="dark"
          toastOptions={{
            classNames: {
              toast: '!bg-[#2a211d] !border !border-[rgba(255,228,206,0.22)] !text-[#f5ede4] !font-sans !rounded-[10px_3px_10px_3px]',
              description: '!text-[#cdbfb3]',
            },
          }}
        />
      </MotionConfig>
    </PineProviders>
  )
}
