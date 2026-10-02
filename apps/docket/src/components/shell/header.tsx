'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Dialog, DropdownMenu } from 'radix-ui'
import { ChevronDown, FilePlus2, Menu, X } from 'lucide-react'
import { useAccount } from '@pine/react'
import { cn } from '@/lib/cn'
import { isActive, PRIMARY_NAV, SECONDARY_NAV } from '@/lib/nav'
import { Wordmark } from './brand'
import { WalletButton } from './wallet-button'
import { ButtonLink } from '@/components/ui/button'
import { useMounted } from '@/lib/use-mounted'

export function Header() {
  const pathname = usePathname() ?? '/'
  const [open, setOpen] = useState(false)
  const [lastPath, setLastPath] = useState(pathname)
  if (lastPath !== pathname) {
    // Close the menu when navigation completes.
    setLastPath(pathname)
    setOpen(false)
  }

  return (
    <header className="border-b-4 border-violet bg-sheet print:hidden">
      <div className="mx-auto flex h-16 max-w-[86rem] items-center gap-4 px-4 sm:px-6 lg:px-10">
        <Link href="/" className="shrink-0 rounded-xs no-underline" aria-label="Pine Docket, home">
          <Wordmark />
        </Link>

        <nav aria-label="Main" className="ml-6 hidden h-full nav:block">
          <ul className="flex h-full items-stretch gap-1">
            {PRIMARY_NAV.map((item) => {
              const active = isActive(pathname, item.match)
              return (
                <li key={item.href} className="flex">
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'relative flex items-center px-3 font-bold no-underline',
                      active ? 'text-violet' : 'text-ink hover:text-violet',
                    )}
                  >
                    {item.label}
                    {active ? <span aria-hidden className="absolute inset-x-3 -bottom-1 h-1 bg-flag" /> : null}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <div className="hidden md:block">
            <WalletButton />
          </div>
          <div className="hidden md:block">
            <AccountMenu />
          </div>
          <ButtonLink
            href="/file"
            size="sm"
            icon={<FilePlus2 aria-hidden />}
            className={cn('hidden sm:inline-flex', pathname.startsWith('/file') && 'sm:hidden')}
          >
            File a verification
          </ButtonLink>
          <Dialog.Root open={open} onOpenChange={setOpen}>
            <Dialog.Trigger asChild>
              <button
                type="button"
                className="inline-flex h-10 items-center gap-2 rounded-sm border border-rule-strong px-3 font-bold nav:hidden"
                aria-label="Open menu"
              >
                <Menu aria-hidden className="size-5" />
                <span className="hidden xs:inline">Menu</span>
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
              <Dialog.Content
                className="fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col overflow-y-auto border-l-4 border-violet bg-sheet shadow-xl focus:outline-none"
                aria-describedby={undefined}
              >
                <div className="flex h-16 items-center justify-between border-b border-rule px-4">
                  <Dialog.Title className="text-lg font-bold">Menu</Dialog.Title>
                  <Dialog.Close className="inline-flex h-10 items-center gap-1.5 rounded-sm px-2 font-bold" aria-label="Close menu">
                    <X aria-hidden className="size-5" /> Close
                  </Dialog.Close>
                </div>
                <nav aria-label="Main" className="px-2 py-3">
                  <ul>
                    {PRIMARY_NAV.map((item) => {
                      const active = isActive(pathname, item.match)
                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            aria-current={active ? 'page' : undefined}
                            className={cn(
                              'flex items-center border-l-4 px-3 py-3 text-lg font-bold no-underline',
                              active ? 'border-flag bg-violet-wash text-violet' : 'border-transparent hover:bg-bond',
                            )}
                          >
                            {item.label}
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                  <ul className="mt-3 border-t border-rule pt-3">
                    {SECONDARY_NAV.map((item) => (
                      <li key={item.href}>
                        <Link href={item.href} className="block px-4 py-2.5 no-underline hover:bg-bond">
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </nav>
                <div className="mt-auto space-y-3 border-t border-rule p-4">
                  <ButtonLink href="/file" className="w-full" icon={<FilePlus2 aria-hidden />}>
                    File a verification
                  </ButtonLink>
                  <div className="flex flex-wrap items-center gap-3">
                    <WalletButton />
                    <AccountMenu />
                  </div>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </div>
    </header>
  )
}

function AccountMenu() {
  const { status, account, signOut } = useAccount()
  const mounted = useMounted()
  if (!mounted || status === 'loading') return <span className="skeleton block h-9 w-24" aria-label="Loading account" />
  if (status !== 'signed_in' || !account) {
    return (
      <Link
        href="/account"
        className="inline-flex h-9 items-center rounded-sm border border-rule-strong bg-sheet px-3 text-sm font-bold no-underline shadow-[0_2px_0_var(--color-rule)] hover:bg-bond"
      >
        Sign in
      </Link>
    )
  }
  const gh = account.github
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-2 rounded-sm border border-rule-strong bg-sheet pr-2 pl-1 text-sm font-bold hover:bg-bond"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={gh.avatarUrl} alt="" className="size-7 rounded-xs bg-mist" width={28} height={28} />
          <span className="max-w-[9rem] truncate">{gh.login}</span>
          <ChevronDown aria-hidden className="size-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[14rem] border border-rule bg-sheet p-1 shadow-[0_8px_24px_rgba(26,29,43,0.14)]"
        >
          <DropdownMenu.Label className="px-3 py-2 text-sm text-graphite">
            Signed in with GitHub as <strong className="text-ink">{gh.login}</strong>
            {account.demo ? ' (demo identity)' : ''}
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="my-1 h-px bg-rule" />
          {[
            { href: '/my-docket', label: 'My docket' },
            { href: '/filings', label: 'Drafts and filings' },
            { href: '/activity', label: 'Activity ledger' },
            { href: '/account', label: 'Account and wallets' },
          ].map((i) => (
            <DropdownMenu.Item key={i.href} asChild>
              <Link
                href={i.href}
                className="block px-3 py-2 no-underline outline-none data-[highlighted]:bg-violet-wash data-[highlighted]:text-violet"
              >
                {i.label}
              </Link>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-rule" />
          <DropdownMenu.Item
            onSelect={() => void signOut()}
            className="block cursor-pointer px-3 py-2 outline-none data-[highlighted]:bg-red-wash data-[highlighted]:text-red"
          >
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
