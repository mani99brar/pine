'use client'

import Link from 'next/link'
import { DropdownMenu } from 'radix-ui'
import { ChevronDown, LogOut, Wallet } from 'lucide-react'
import { formatAmount, shortHash } from '@pine/core'
import { useWallet } from '@pine/react'
import { cn } from '@/lib/cn'
import { buttonClass } from '@/components/ui/Button'

const item =
  'flex h-9 cursor-pointer items-center gap-2 rounded-[3px] px-2.5 text-[0.9rem] text-ink outline-none data-[highlighted]:bg-fog-2'

export function WalletButton({ className, block }: { className?: string; block?: boolean }) {
  const w = useWallet()
  if (!w.isConnected || !w.address) {
    return (
      <button type="button" onClick={() => w.connect()} className={buttonClass('secondary', 'md', cn(block && 'w-full', className))}>
        <Wallet size={16} aria-hidden />
        {w.isReconnecting ? 'Reconnecting…' : w.isDemo ? 'Connect demo wallet' : 'Connect wallet'}
      </button>
    )
  }
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className={cn(
          'inline-flex h-10 items-center gap-2 rounded-[var(--radius-btn)] border-[1.5px] border-ink bg-sheet pl-2.5 pr-2 text-[0.9rem] font-[600] hover:bg-ink/[0.04]',
          block && 'w-full justify-between',
          className,
        )}
        aria-label={`Wallet ${w.address}${w.isDemo ? ' (simulated)' : ''}`}
      >
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className={cn('h-2.5 w-2.5 rounded-full', w.isDemo ? 'bg-lumen shadow-[0_0_0_1.5px_var(--ink)]' : 'bg-cobalt')} />
          <code className="t-code text-[0.8rem]">{shortHash(w.address, 4)}</code>
          {w.balance && (
            <span className="hidden text-ink-2 xl:inline">
              <span className="t-figure text-[0.95rem] text-ink">{formatAmount(w.balance.amount, { maxDecimals: 2 })}</span> {w.balance.symbol}
            </span>
          )}
        </span>
        <ChevronDown size={14} aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-[15rem] rounded-[4px] border-[1.5px] border-ink bg-sheet p-1.5">
          <div className="px-2.5 pb-2 pt-1.5">
            <p className="text-[0.78rem] text-ink-3">{w.isDemo ? 'Simulated demo wallet' : 'Connected wallet'}</p>
            <code className="t-code mt-0.5 block break-all text-[0.78rem]">{w.address}</code>
            {w.balance && (
              <p className="mt-1.5 text-[0.85rem] text-ink-2">
                <span className="t-figure text-[1.05rem] text-ink">{formatAmount(w.balance.amount, { maxDecimals: 2 })}</span> {w.balance.symbol}
                {w.nativeBalance && (
                  <>
                    {'  '}
                    <span className="ml-2 t-figure text-[1.05rem] text-ink">{formatAmount(w.nativeBalance.amount, { maxDecimals: 3 })}</span>{' '}
                    {w.nativeBalance.symbol}
                  </>
                )}
              </p>
            )}
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item asChild className={item}>
            <Link href="/dashboard">Dashboard</Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild className={item}>
            <Link href="/activity">Activity and reconciliation</Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item className={item} onSelect={() => w.disconnect()}>
            <LogOut size={14} aria-hidden />
            Disconnect
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
