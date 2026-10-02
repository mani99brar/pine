'use client'

import type { Session } from 'next-auth'
import { lightTheme } from '@rainbow-me/rainbowkit'
import { Toaster } from 'sonner'
import { PineProviders } from '@pine/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkbenchProvider } from '@/components/shell/workbench'

const rainbow = lightTheme({ accentColor: '#1c5d50', borderRadius: 'small', fontStack: 'system' })

export function Providers({ children, session }: { children: React.ReactNode; session: Session | null }) {
  return (
    <PineProviders appName="Pine Console" session={session} rainbowTheme={rainbow}>
      <TooltipProvider>
        <WorkbenchProvider>
          {children}
          <Toaster
            position="bottom-right"
            theme="system"
            offset={{ bottom: 40 }}
            mobileOffset={{ bottom: 72 }}
            toastOptions={{
              classNames: {
                toast: '!bg-raised !text-bark !border-line !shadow-float !rounded-float !font-sans',
                description: '!text-muted',
              },
            }}
          />
        </WorkbenchProvider>
      </TooltipProvider>
    </PineProviders>
  )
}
