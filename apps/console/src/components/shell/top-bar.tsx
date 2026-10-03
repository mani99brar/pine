'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Monitor, Moon, Search, Sun } from 'lucide-react'
import { formatClaimNumber } from '@pine/core'
import { cn } from '@/lib/cn'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip } from '@/components/ui/tooltip'
import { PineMark } from '@/components/ui/pine-mark'
import { useWorkbench } from './workbench'
import { WalletButton } from './wallet-button'

const LABELS: Record<string, string> = {
  claims: 'Claims',
  new: 'New verification',
  drafts: 'Drafts',
  dashboard: 'Dashboard',
  repos: 'Repositories',
  policies: 'Policies',
  agents: 'Agents',
  risks: 'Risks & launch gates',
  activity: 'Activity',
  settings: 'Settings',
  evidence: 'Evidence',
}

export function crumbsFor(pathname: string, claim?: { id: string; number: number } | null): { href: string; label: string }[] {
  const parts = pathname.split('/').filter(Boolean)
  const out: { href: string; label: string }[] = []
  let href = ''
  parts.forEach((p, i) => {
    href += `/${p}`
    const prev = parts[i - 1]
    // Segments without their own page are folded into the next crumb.
    if (p === 'pull' || p === 'evidence') return
    if (parts[0] === 'repos' && i === 1) return
    let label = LABELS[p] ?? decodeURIComponent(p)
    if (prev === 'claims' && claim && claim.id === p) label = formatClaimNumber(claim.number)
    else if (prev === 'claims' && /^pine-\d+$/i.test(p)) label = p.toUpperCase()
    if (parts[0] === 'repos' && i === 2) label = `${decodeURIComponent(parts[1] ?? '')}/${decodeURIComponent(p)}`
    if (prev === 'pull') label = `#${p}`
    if (prev === 'evidence' && p === 'new') label = 'Submit evidence'
    if (prev === 'policies') label = decodeURIComponent(p).toUpperCase()
    out.push({ href, label })
  })
  return out
}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, cycleTheme } = useWorkbench()
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor
  const label = `Theme: ${theme}. Press t to cycle.`
  return (
    <Tooltip content={label}>
      <button
        type="button"
        onClick={cycleTheme}
        aria-label={label}
        className={cn('flex size-7 items-center justify-center rounded-ctl text-muted hover:bg-sunken hover:text-bark', className)}
      >
        <Icon size={15} aria-hidden />
      </button>
    </Tooltip>
  )
}

export function TopBar() {
  const pathname = usePathname() ?? '/'
  const { openPalette, claim } = useWorkbench()
  const crumbs = crumbsFor(pathname, claim)
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-line bg-frost/92 px-3 backdrop-blur supports-[backdrop-filter]:bg-frost/80 sm:px-4">
      <Link href="/" className="text-needle lg:hidden" aria-label="Pine Console home">
        <PineMark size={22} />
      </Link>
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <li className="hidden shrink-0 text-muted sm:block">
            <Link href="/" className="hover:text-bark">
              console
            </Link>
          </li>
          {crumbs.map((c, i) => (
            <li key={c.href} className={cn('flex min-w-0 items-center gap-1.5', i < crumbs.length - 2 && 'hidden md:flex')}>
              <span className={cn('text-faint', i === 0 && 'hidden sm:inline')} aria-hidden>
                /
              </span>
              {i === crumbs.length - 1 ? (
                <span aria-current="page" className="truncate font-medium text-bark">
                  {c.label}
                </span>
              ) : (
                <Link href={c.href} className="truncate text-muted hover:text-bark">
                  {c.label}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <button
        type="button"
        onClick={() => openPalette()}
        className="group hidden h-8 w-[min(420px,36vw)] items-center gap-2 rounded-ctl border border-line-strong bg-surface px-2.5 text-left text-[13px] text-faint transition-colors hover:border-needle md:flex"
        aria-label="Open command palette"
      >
        <Search size={14} aria-hidden className="shrink-0" />
        <span className="flex-1 truncate">Search, run a command, or paste a GitHub URL</span>
        <Kbd>⌘K</Kbd>
      </button>
      <button
        type="button"
        onClick={() => openPalette()}
        className="flex size-8 items-center justify-center rounded-ctl text-muted hover:bg-sunken md:hidden"
        aria-label="Open command palette"
      >
        <Search size={16} aria-hidden />
      </button>
      <ThemeToggle className="hidden sm:flex" />
      <WalletButton compact />
    </header>
  )
}
