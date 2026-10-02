'use client'

import Link from 'next/link'
import { DropdownMenu } from 'radix-ui'
import { LogOut, UserRound } from 'lucide-react'
import { useAccount } from '@pine/react'
import { cn } from '@/lib/cn'

const item =
  'flex h-9 cursor-pointer items-center gap-2 rounded-[3px] px-2.5 text-[0.9rem] text-ink outline-none data-[highlighted]:bg-fog-2'

export function AccountMenu({ className }: { className?: string }) {
  const a = useAccount()
  if (a.status !== 'signed_in' || !a.account) {
    return (
      <Link
        href="/account"
        className={cn('inline-flex h-10 items-center gap-1.5 rounded-[var(--radius-btn)] px-3 text-[0.92rem] font-[600] text-ink hover:bg-ink/[0.07]', className)}
      >
        <UserRound size={16} aria-hidden />
        {a.status === 'loading' ? <span className="sr-only">Loading account</span> : 'Sign in'}
      </Link>
    )
  }
  const gh = a.account.github
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className={cn('inline-flex h-10 items-center gap-2 rounded-[var(--radius-btn)] px-1.5 hover:bg-ink/[0.07]', className)}
        aria-label={`Account menu for ${gh.login}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={gh.avatarUrl} alt="" width={28} height={28} className="h-7 w-7 rounded-full border-[1.5px] border-ink bg-fog-2" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-[14rem] rounded-[4px] border-[1.5px] border-ink bg-sheet p-1.5">
          <div className="px-2.5 pb-2 pt-1.5">
            <p className="font-[650]">{gh.name ?? gh.login}</p>
            <p className="text-[0.8rem] text-ink-3">
              @{gh.login}
              {a.account.demo ? ', demo identity' : ''}
            </p>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          {[
            ['/dashboard', 'Dashboard'],
            ['/drafts', 'Drafts and publications'],
            ['/activity', 'Activity'],
            ['/account', 'Account and settings'],
          ].map(([href, label]) => (
            <DropdownMenu.Item key={href} asChild className={item}>
              <Link href={href!}>{label}</Link>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item className={item} onSelect={() => void a.signOut()}>
            <LogOut size={14} aria-hidden />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
