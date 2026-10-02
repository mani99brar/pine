'use client'

import { Sidebar } from './sidebar'
import { TopBar } from './top-bar'
import { StatusBar } from './status-bar'
import { MobileNav } from './mobile-nav'
import { DemoBanner } from './demo-banner'
import { CommandPalette } from './command-palette'
import { ShortcutsSheet } from './shortcuts-sheet'

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only z-[70] rounded-ctl bg-needle px-3 py-2 text-needle-ink focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <DemoBanner />
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 pb-20 focus:outline-none lg:pb-0">
          {children}
        </main>
        <StatusBar />
      </div>
      <MobileNav />
      <CommandPalette />
      <ShortcutsSheet />
    </div>
  )
}
