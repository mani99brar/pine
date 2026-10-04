'use client'

import Link from 'next/link'
import { toast } from 'sonner'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { DropdownMenu, Dialog as RDialog } from 'radix-ui'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronDown, Menu, Plus, Wallet, X } from 'lucide-react'
import { useAccount, type BackendIdentity } from '@pine/react'
import { PrismMark } from '@/components/icons'
import { NAV, SECONDARY_NAV } from '@/lib/site'
import { useMounted, useReduceMotion } from '@/lib/hooks'
import { cn } from '@/lib/cn'
import { SessionWalletGuard } from './SessionWalletGuard'
import { WalletButton } from './WalletButton'
import { shortAddress } from './wallet-display'

function isActive(pathname: string, href: string) {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function Initials({ name, size = 32 }: { name: string; size?: number }) {
  const parts = name.replace(/[^a-zA-Z0-9 -]/g, ' ').split(/[\s-]+/).filter(Boolean)
  const text = ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase()
  return (
    <span
      aria-hidden
      className="cut-sm inline-flex shrink-0 items-center justify-center bg-[linear-gradient(135deg,#ffb648,#ff6b83_55%,#b79aff)] font-semibold text-umbra"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {text}
    </span>
  )
}

const MENU_ITEM = 'block rounded-[4px] px-3 py-2 text-[0.9rem] text-lumen-2 outline-none data-[highlighted]:bg-smoke-3 data-[highlighted]:text-lumen'

/** `api` mode: the session wallet is the account; GitHub is linked to it. The glyph links to /account, the chevron opens the menu. */
function BackendAccountMenu({ backend, signOut }: { backend: BackendIdentity; signOut: () => Promise<void> }) {
  const wallet = backend.wallet ? shortAddress(backend.wallet) : 'your wallet'
  const login = backend.github?.login
  const terms = backend.termsAccepted ? '' : ', terms need accepting'
  return (
    <div className="flex items-center">
      <Link
        href="/account"
        className="cut-sm relative inline-flex items-center rounded-sm p-0.5 hover:bg-smoke-3"
        aria-label={`Account, signed in as ${wallet}${login ? `, GitHub @${login}` : ''}${terms}`}
      >
        {login ? (
          <Initials name={login} />
        ) : (
          <span aria-hidden className="cut-sm inline-flex h-8 w-8 items-center justify-center bg-[linear-gradient(135deg,#ffb648,#ff6b83_55%,#b79aff)] text-umbra">
            <Wallet size={16} />
          </span>
        )}
        {!backend.termsAccepted && <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-umbra bg-na" />}
      </Link>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="inline-flex h-8 w-6 items-center justify-center rounded-[4px] text-lumen-3 hover:bg-smoke-3 hover:text-lumen" aria-label="Open the account menu">
          <ChevronDown size={15} aria-hidden />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={8} className="glass-float cut-lg z-[80] min-w-[14rem] p-1.5">
            <DropdownMenu.Label className="px-3 pb-2 pt-1.5 text-[0.8125rem] text-lumen-3">
              Signed in as <span className="t-code text-lumen">{wallet}</span>
              <span className="mt-0.5 block">
                {login ? (
                  <>
                    GitHub <span className="font-semibold text-lumen">@{login}</span>
                  </>
                ) : (
                  'GitHub not linked'
                )}
              </span>
            </DropdownMenu.Label>
            {!backend.termsAccepted && (
              <DropdownMenu.Item asChild>
                <Link href="/account" className={cn(MENU_ITEM, 'text-na')}>
                  Accept the updated terms
                </Link>
              </DropdownMenu.Item>
            )}
            {SECONDARY_NAV.map((n) => (
              <DropdownMenu.Item key={n.href} asChild>
                <Link href={n.href} className={MENU_ITEM}>
                  {n.label}
                </Link>
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator className="my-1 h-px bg-edge" />
            <DropdownMenu.Item
              onSelect={() =>
                void signOut().catch((e: unknown) =>
                  // The session stays valid when Pine could not end it: say so instead of looking signed out.
                  toast.error('Pine could not sign you out', { description: e instanceof Error ? e.message : 'Try again in a moment.' }),
                )
              }
              className={cn(MENU_ITEM, 'cursor-pointer')}
            >
              Sign out
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  )
}

function AccountMenu() {
  const mounted = useMounted()
  const { status, account, user, signOut, backend, refresh } = useAccount()
  if (!mounted || status === 'loading') return <span className="skeleton inline-block h-8 w-8" aria-hidden />
  if (status === 'error') {
    // Pine could not be asked: neither "Sign in" (a second session) nor an account it cannot confirm.
    return (
      <button type="button" onClick={() => void refresh()} className="btn btn-ghost btn-sm" aria-label="Retry: Pine could not check your sign-in">
        Retry
      </button>
    )
  }
  if (status === 'signed_out') {
    return (
      <Link href="/account" className="btn btn-ghost btn-sm">
        Sign in
      </Link>
    )
  }
  if (backend) return <BackendAccountMenu backend={backend} signOut={() => signOut()} />
  const login = account?.github.login ?? user?.login ?? 'account'
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="cut-sm inline-flex items-center rounded-sm p-0.5 hover:bg-smoke-3" aria-label={`Account menu for ${login}`}>
        <Initials name={account?.github.name ?? login} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} className="glass-float cut-lg z-[80] min-w-[13rem] p-1.5">
          <DropdownMenu.Label className="px-3 pb-2 pt-1.5 text-[0.8125rem] text-lumen-3">
            Signed in as <span className="font-semibold text-lumen">{login}</span>
            {account?.demo && <span className="ml-1">(demo)</span>}
          </DropdownMenu.Label>
          {SECONDARY_NAV.map((n) => (
            <DropdownMenu.Item key={n.href} asChild>
              <Link href={n.href} className="block rounded-[4px] px-3 py-2 text-[0.9rem] text-lumen-2 outline-none data-[highlighted]:bg-smoke-3 data-[highlighted]:text-lumen">
                {n.label}
              </Link>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-edge" />
          <DropdownMenu.Item onSelect={() => void signOut()} className="cursor-pointer rounded-[4px] px-3 py-2 text-[0.9rem] text-lumen-2 outline-none data-[highlighted]:bg-smoke-3 data-[highlighted]:text-lumen">
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function MobileNav({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false)
  const reduce = useReduceMotion()
  const links = [...NAV, ...SECONDARY_NAV]
  return (
    <RDialog.Root open={open} onOpenChange={setOpen}>
      <RDialog.Trigger className="btn btn-ghost btn-sm -mr-2 px-2 lg:hidden" aria-label="Open navigation">
        <Menu size={20} aria-hidden />
      </RDialog.Trigger>
      <AnimatePresence>
        {open && (
          <RDialog.Portal forceMount>
            <RDialog.Overlay forceMount asChild>
              <motion.div className="fixed inset-0 z-[88] bg-[rgba(8,6,5,0.8)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            </RDialog.Overlay>
            <RDialog.Content forceMount asChild>
              <motion.div
                className="fixed inset-y-0 right-0 z-[89] flex w-[min(24rem,100vw)] flex-col overflow-y-auto border-l border-edge bg-[#1a1412] p-5 focus:outline-none"
                initial={reduce ? { opacity: 0 } : { x: '100%' }}
                animate={reduce ? { opacity: 1 } : { x: 0 }}
                exit={reduce ? { opacity: 0 } : { x: '100%' }}
                transition={{ type: 'spring', stiffness: 380, damping: 38 }}
              >
                <div className="flex items-center justify-between">
                  <RDialog.Title className="flex items-center gap-2 font-cut text-[1.05rem] font-medium">
                    <PrismMark size={24} /> Pine Prism
                  </RDialog.Title>
                  <RDialog.Close className="btn btn-ghost btn-sm px-2" aria-label="Close navigation">
                    <X size={20} aria-hidden />
                  </RDialog.Close>
                </div>
                <RDialog.Description className="sr-only">Site navigation</RDialog.Description>
                <div aria-hidden className="spectrum-line mt-5 opacity-70" />
                <nav className="mt-4 grid gap-0.5" aria-label="Mobile">
                  {links.map((n, i) => (
                    <motion.div key={n.href} initial={reduce ? false : { opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: reduce ? 0 : 0.04 * i, type: 'spring', stiffness: 400, damping: 34 }}>
                      <Link
                        href={n.href}
                        onClick={() => setOpen(false)}
                        aria-current={isActive(pathname, n.href) ? 'page' : undefined}
                        className={cn(
                          'flex items-center justify-between rounded-[6px] px-3 py-3 font-cut text-[1.35rem] font-light tracking-[-0.01em]',
                          isActive(pathname, n.href) ? 'bg-smoke-2 text-lumen' : 'text-lumen-2 hover:bg-smoke-2 hover:text-lumen',
                        )}
                      >
                        {n.label}
                        {isActive(pathname, n.href) && <span aria-hidden className="h-1.5 w-6 rounded-full" style={{ background: 'var(--spectrum)' }} />}
                      </Link>
                    </motion.div>
                  ))}
                </nav>
                <div className="mt-6 grid gap-3">
                  <Link href="/compose" onClick={() => setOpen(false)} className="btn btn-light w-full">
                    <Plus size={16} aria-hidden /> Compose a claim
                  </Link>
                  <WalletButton block />
                </div>
              </motion.div>
            </RDialog.Content>
          </RDialog.Portal>
        )}
      </AnimatePresence>
    </RDialog.Root>
  )
}

export function SiteHeader() {
  const pathname = usePathname() ?? '/'
  const reduce = useReduceMotion()
  return (
    <header className="glass-float sticky top-0 z-[60] border-x-0 border-t-0">
      <SessionWalletGuard />
      <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="group mr-2 flex shrink-0 items-center gap-2.5" aria-label="Pine Prism home">
          <PrismMark size={30} className="transition-transform duration-300 group-hover:rotate-[-6deg]" />
          <span className="font-cut text-[1.08rem] font-medium tracking-[-0.01em]">
            Pine <span className="font-light text-lumen-2">Prism</span>
          </span>
        </Link>
        <nav className="hidden items-center gap-1 lg:flex" aria-label="Primary">
          {NAV.map((n) => {
            const active = isActive(pathname, n.href)
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? 'page' : undefined}
                className={cn('relative rounded-[6px] px-3 py-2 text-[0.9375rem] font-medium transition-colors', active ? 'text-lumen' : 'text-lumen-2 hover:text-lumen')}
              >
                {n.label}
                {active && (
                  <motion.span
                    layoutId="nav-beam"
                    aria-hidden
                    className="absolute inset-x-3 -bottom-[13px] h-[2px] rounded-full"
                    style={{ background: 'var(--spectrum)', boxShadow: '0 0 12px rgba(255,236,220,0.45)' }}
                    transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
              </Link>
            )
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <div className="hidden sm:block">
            <WalletButton />
          </div>
          <AccountMenu />
          <Link href="/compose" className="btn btn-light btn-sm hidden md:inline-flex">
            <Plus size={15} aria-hidden /> New claim
          </Link>
          <MobileNav pathname={pathname} />
        </div>
      </div>
    </header>
  )
}
