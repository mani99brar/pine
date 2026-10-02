'use client'

import type { Session } from 'next-auth'
import { lightTheme } from '@rainbow-me/rainbowkit'
import { Toaster } from 'sonner'
import { notifyManager } from '@tanstack/react-query'
import { PineProviders } from '@pine/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkbenchProvider } from '@/components/shell/workbench'
import type { ThemePref } from '@/lib/theme'
import { QaHooks } from './qa-hooks'

// The composer's draft lives in the TanStack Query cache and is bound to controlled inputs. The default
// notify scheduler defers cache notifications to a later tick, so React restores the old input value first
// and the caret jumps to the end while typing mid-text. Notifying synchronously keeps edits in place.
notifyManager.setScheduler((cb) => cb())

const rainbow = lightTheme({ accentColor: '#1c5d50', borderRadius: 'small', fontStack: 'system' })

export function Providers({ children, session, theme }: { children: React.ReactNode; session: Session | null; theme: ThemePref }) {
  return (
    <PineProviders appName="Pine Console" session={session} rainbowTheme={rainbow}>
      <QaHooks />
      <TooltipProvider>
        <WorkbenchProvider initialTheme={theme}>
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
