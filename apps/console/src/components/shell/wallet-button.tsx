'use client'

import { DropdownMenu } from 'radix-ui'
import { Wallet, ChevronDown, Zap, LogOut, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { formatAmount, shortHash } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { useDemoWallet, useWallet } from '@pine/react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'

export function WalletButton({ compact }: { compact?: boolean }) {
  const w = useWallet()
  const demo = useDemoWallet()
  if (!w.isConnected || !w.address) {
    return (
      <Button variant="secondary" size="sm" onClick={() => w.connect()} aria-label="Connect wallet">
        <Wallet size={14} aria-hidden />
        {!compact ? <span>{w.isDemo || demo.enabled ? 'Connect demo wallet' : 'Connect wallet'}</span> : null}
      </Button>
    )
  }
  const chain = getChainOrDefault(w.chainId)
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex h-7 items-center gap-2 rounded-ctl border border-line-strong bg-surface px-2 text-xs hover:border-needle"
          aria-label={`Wallet ${w.address}`}
        >
          <span className={cn('size-2 rounded-full', w.isDemo ? 'bg-resin-fill' : 'bg-needle')} aria-hidden />
          <span className="mono-cond text-[11.5px]">{shortHash(w.address)}</span>
          {!compact && w.balance ? (
            <span className="tnum hidden text-muted xl:inline">{formatAmount(w.balance.amount, { symbol: w.balance.symbol, maxDecimals: 2 })}</span>
          ) : null}
          <ChevronDown size={12} aria-hidden className="text-faint" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="animate-fade-in z-50 w-72 rounded-float border border-line bg-raised p-1.5 text-sm shadow-float"
        >
          <div className="px-2 py-1.5">
            <p className="text-xs text-muted">{w.isDemo ? 'Simulated wallet' : 'Connected wallet'} on {chain.name}</p>
            <p className="mono-cond mt-0.5 break-all text-[11.5px]">{w.address}</p>
            {w.balance ? (
              <p className="tnum mt-1 text-xs text-muted">
                Balance {formatAmount(w.balance.amount, { symbol: w.balance.symbol, maxDecimals: 4 })}
              </p>
            ) : null}
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item
            className="flex h-8 cursor-pointer items-center gap-2 rounded-ctl px-2 outline-none data-[highlighted]:bg-sunken"
            onSelect={() => {
              void navigator.clipboard.writeText(w.address!).then(() => toast.success('Copied address'))
            }}
          >
            <Copy size={14} aria-hidden className="text-muted" /> Copy address
          </DropdownMenu.Item>
          {demo.enabled ? (
            <DropdownMenu.Item
              className="flex h-8 cursor-pointer items-center gap-2 rounded-ctl px-2 outline-none data-[highlighted]:bg-sunken"
              onSelect={() => {
                demo.failNext()
                toast('The next simulated transaction will fail', { description: 'Use it to exercise retry and recovery.' })
              }}
            >
              <Zap size={14} aria-hidden className="text-resin" />
              {demo.pendingFailure ? 'Failure armed for next transaction' : 'Simulate failure on next transaction'}
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item
            className="flex h-8 cursor-pointer items-center gap-2 rounded-ctl px-2 outline-none data-[highlighted]:bg-sunken"
            onSelect={() => w.disconnect()}
          >
            <LogOut size={14} aria-hidden className="text-muted" /> Disconnect
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
