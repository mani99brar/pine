'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { NAV, NAV_GROUPS, isActive } from '@/lib/nav'
import { Kbd } from '@/components/ui/kbd'
import { PineMark } from '@/components/ui/pine-mark'
import { AccountChip } from './account'

export function Brand({ compact }: { compact?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2 rounded-ctl text-bark" aria-label="Pine Console home">
      <PineMark size={22} className="text-needle" />
      {!compact ? (
        <span className="stretch-display text-[17px] font-[750] leading-none tracking-[-0.01em]">
          Pine<span className="ml-1 font-[450] text-muted">Console</span>
        </span>
      ) : null}
    </Link>
  )
}

export function NavList({ onNavigate, showKeys = true }: { onNavigate?: () => void; showKeys?: boolean }) {
  const pathname = usePathname() ?? '/'
  return (
    <nav aria-label="Primary" className="flex flex-col gap-3">
      {NAV_GROUPS.map((g, gi) => (
        <ul key={g.id} className={cn('flex flex-col gap-px', gi > 0 && 'border-t border-line pt-3')} aria-label={g.label}>
          {NAV.filter((n) => n.group === g.id && n.href !== '/new').map((item) => {
            const active = isActive(item, pathname)
            const Icon = item.icon
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'group relative flex h-8 items-center gap-2.5 rounded-ctl px-2.5 text-[13.5px] text-muted transition-colors hover:bg-sunken hover:text-bark',
                    active && 'bg-sunken font-medium text-bark before:absolute before:-left-3 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-full before:bg-needle',
                  )}
                >
                  <Icon size={15} aria-hidden className={cn('shrink-0', active ? 'text-needle' : 'text-faint group-hover:text-bark')} />
                  <span className="truncate">{item.label}</span>
                  {showKeys && item.keys ? (
                    <Kbd className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                      {item.keys}
                    </Kbd>
                  ) : null}
                </Link>
              </li>
            )
          })}
        </ul>
      ))}
    </nav>
  )
}

export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-[232px] shrink-0 flex-col border-r border-line bg-frost lg:flex" aria-label="Workbench navigation">
      <div className="flex h-12 items-center px-4">
        <Brand />
      </div>
      <div className="px-3 pb-3">
        <Link
          href="/new"
          className="flex h-8 items-center gap-2 rounded-ctl border border-needle bg-needle px-2.5 text-[13.5px] font-medium text-needle-ink transition-[filter] hover:brightness-110"
        >
          <Plus size={15} aria-hidden />
          New verification
          <Kbd className="ml-auto border-needle-ink/30 bg-transparent text-needle-ink/80 shadow-none">n</Kbd>
        </Link>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <NavList />
      </div>
      <div className="border-t border-line p-3">
        <AccountChip />
      </div>
    </aside>
  )
}
