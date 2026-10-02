'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Dialog } from 'radix-ui'
import { Menu, Plus, X } from 'lucide-react'
import { NAV } from '@/lib/site'
import { cn } from '@/lib/cn'
import { ButtonLink } from '@/components/ui/Button'
import { Wordmark } from './Logo'
import { WalletButton } from './WalletButton'
import { AccountMenu } from './AccountMenu'

function isActive(pathname: string, href: string): boolean {
  if (href === '/board') return pathname === '/board' || pathname.startsWith('/claims')
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function SiteHeader() {
  const pathname = usePathname() ?? '/'
  const [open, setOpen] = useState(false)

  return (
    <header className="sticky top-0 z-40 border-b border-line-strong bg-fog">
      <div className="mx-auto flex h-16 max-w-[1320px] items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="-ml-1 rounded-[4px] px-1 py-1" aria-label="Pine Field home">
          <Wordmark />
        </Link>

        <nav aria-label="Primary" className="ml-4 hidden h-full items-stretch lg:flex">
          {NAV.map((n) => {
            const active = isActive(pathname, n.href)
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex items-center px-3 text-[0.94rem] font-[600] transition-colors',
                  active ? 'text-ink' : 'text-ink-2 hover:text-ink',
                )}
              >
                {n.label}
                {active && <span aria-hidden className="absolute inset-x-3 bottom-0 h-[3px] bg-ink" />}
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto hidden items-center gap-2 lg:flex">
          <ButtonLink href="/compose" icon={<Plus size={16} aria-hidden />}>
            Put a claim on the board
          </ButtonLink>
          <WalletButton />
          <AccountMenu />
        </div>

        <div className="ml-auto flex items-center gap-1 lg:hidden">
          <ButtonLink href="/compose" size="sm" className="hidden sm:inline-flex" icon={<Plus size={15} aria-hidden />}>
            New claim
          </ButtonLink>
          <Dialog.Root open={open} onOpenChange={setOpen}>
            <Dialog.Trigger className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-btn)] px-3 font-[620] hover:bg-ink/[0.07]" aria-label="Open menu">
              <Menu size={20} aria-hidden />
              <span className="text-[0.92rem]">Menu</span>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Content className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-fog data-[state=open]:animate-[fade-in_140ms_ease-out]" aria-describedby={undefined}>
                <div className="flex h-16 items-center justify-between border-b border-line-strong px-4">
                  <Wordmark />
                  <Dialog.Title className="sr-only">Menu</Dialog.Title>
                  <Dialog.Close className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-btn)] px-3 font-[620] hover:bg-ink/[0.07]" aria-label="Close menu">
                    <X size={20} aria-hidden />
                    <span className="text-[0.92rem]">Close</span>
                  </Dialog.Close>
                </div>
                <nav aria-label="Primary" className="flex flex-col px-4 pt-4">
                  {[{ href: '/', label: 'Home' }, ...NAV, { href: '/drafts', label: 'Drafts' }, { href: '/activity', label: 'Activity' }, { href: '/risks', label: 'Risks and launch gates' }].map((n) => {
                    const active = n.href === '/' ? pathname === '/' : isActive(pathname, n.href)
                    return (
                      <Link
                        key={n.href}
                        href={n.href}
                        onClick={() => setOpen(false)}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex items-center justify-between border-b border-line py-3.5 font-display text-[1.6rem] leading-none font-[760] [font-stretch:120%]',
                          active ? 'text-ink' : 'text-ink-2',
                        )}
                      >
                        {n.label}
                        {active && <span aria-hidden className="h-3 w-3 bg-ink" />}
                      </Link>
                    )
                  })}
                </nav>
                <div className="mt-auto flex flex-col gap-3 px-4 pb-8 pt-8">
                  <ButtonLink href="/compose" size="lg" onClick={() => setOpen(false)} icon={<Plus size={18} aria-hidden />}>
                    Put a claim on the board
                  </ButtonLink>
                  <WalletButton block />
                  <Link href="/account" onClick={() => setOpen(false)} className="py-2 text-center font-[600] underline underline-offset-4">
                    Account and settings
                  </Link>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </div>
    </header>
  )
}
