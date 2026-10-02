'use client'

import Link from 'next/link'
import Image from 'next/image'
import { LogIn } from 'lucide-react'
import { useAccount } from '@pine/react'
import { cn } from '@/lib/cn'
import { Skeleton } from '@/components/ui/skeleton'

export function Avatar({ src, login, size = 24, className }: { src?: string; login: string; size?: number; className?: string }) {
  const remote = src && /^https:\/\/avatars\.githubusercontent\.com\//.test(src)
  return remote ? (
    <Image src={src} alt="" width={size} height={size} className={cn('shrink-0 rounded-full border border-line', className)} unoptimized />
  ) : (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn('stretch-cond flex shrink-0 items-center justify-center rounded-full border border-line bg-needle-soft text-[11px] font-semibold uppercase text-needle', className)}
    >
      {login.slice(0, 2)}
    </span>
  )
}

export function AccountChip() {
  const { status, account } = useAccount()
  if (status === 'loading') return <Skeleton className="h-8 w-full" />
  if (!account)
    return (
      <Link
        href="/settings"
        className="flex h-8 items-center gap-2 rounded-ctl px-2 text-[13px] text-muted hover:bg-sunken hover:text-bark"
      >
        <LogIn size={15} aria-hidden />
        Sign in with GitHub
      </Link>
    )
  return (
    <Link href="/settings" className="flex min-w-0 items-center gap-2 rounded-ctl px-1.5 py-1 hover:bg-sunken">
      <Avatar src={account.github.avatarUrl} login={account.github.login} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{account.github.name ?? account.github.login}</span>
        <span className="block truncate text-[11.5px] text-muted">
          @{account.github.login}
          {account.demo ? ' (demo identity)' : ''}
        </span>
      </span>
    </Link>
  )
}
