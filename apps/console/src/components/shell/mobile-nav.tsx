'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, Menu, Plus, Search, Table2, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog'
import { useWorkbench } from './workbench'
import { NavList, Brand } from './sidebar'
import { AccountChip } from './account'
import { ThemeToggle } from './top-bar'
import { UtcClock } from './status-bar'

/** Below lg: the rail becomes a bottom bar plus a "More" drawer. */
export function MobileNav() {
  const pathname = usePathname() ?? '/'
  const { openPalette, mobileNavOpen, setMobileNavOpen } = useWorkbench()
  const item = (href: string, label: string, Icon: typeof Table2, active: boolean) => (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn('flex flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] text-muted', active && 'text-needle')}
    >
      <Icon size={18} aria-hidden />
      {label}
    </Link>
  )
  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 flex h-14 items-stretch border-t border-line bg-frost/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        {item('/dashboard', 'Dashboard', LayoutDashboard, pathname.startsWith('/dashboard'))}
        {item('/claims', 'Claims', Table2, pathname.startsWith('/claims'))}
        <Link href="/new" className="flex flex-1 items-center justify-center" aria-label="New verification">
          <span className={cn('flex size-10 items-center justify-center rounded-ctl bg-needle text-needle-ink', pathname === '/new' && 'ring-2 ring-needle/40 ring-offset-2 ring-offset-frost')}>
            <Plus size={20} aria-hidden />
          </span>
        </Link>
        <button type="button" onClick={() => openPalette()} className="flex flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] text-muted">
          <Search size={18} aria-hidden />
          Search
        </button>
        <button
          type="button"
          onClick={() => setMobileNavOpen(true)}
          className="flex flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] text-muted"
          aria-haspopup="dialog"
        >
          <Menu size={18} aria-hidden />
          More
        </button>
      </nav>
      <Dialog open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <DialogContent title="Navigation" side="left" hideTitle>
          <div className="flex h-full flex-col">
            <div className="flex h-12 items-center justify-between border-b border-line px-4">
              <Brand />
              <span className="flex items-center gap-1">
                <ThemeToggle />
                <DialogClose className="flex size-7 items-center justify-center rounded-ctl text-muted hover:bg-sunken hover:text-bark" aria-label="Close navigation">
                  <X size={16} aria-hidden />
                </DialogClose>
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <NavList onNavigate={() => setMobileNavOpen(false)} showKeys={false} />
            </div>
            <div className="space-y-2 border-t border-line p-3">
              <AccountChip />
              <UtcClock className="block px-1.5 text-muted" />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
