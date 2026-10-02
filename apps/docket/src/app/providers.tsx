'use client'

import type { ReactNode } from 'react'
import type { Session } from 'next-auth'
import { lightTheme } from '@rainbow-me/rainbowkit'
import { Toaster } from 'sonner'
import { PineProviders } from '@pine/react'
import '@rainbow-me/rainbowkit/styles.css'

const rainbowTheme = lightTheme({
  accentColor: '#4433a6',
  accentColorForeground: '#ffffff',
  borderRadius: 'small',
  fontStack: 'system',
  overlayBlur: 'small',
})

export function Providers({ children, session }: { children: ReactNode; session: Session | null }) {
  return (
    <PineProviders appName="Pine Docket" session={session} rainbowTheme={rainbowTheme}>
      {children}
      <Toaster
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast: 'rounded-xs! border! border-rule! bg-sheet! text-ink! shadow-[0_8px_24px_rgba(26,29,43,0.16)]! font-sans!',
            title: 'font-bold! text-[15px]!',
            description: 'text-graphite! text-sm!',
          },
        }}
      />
    </PineProviders>
  )
}
