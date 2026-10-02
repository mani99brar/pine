'use client'

import { DropdownMenu } from 'radix-ui'
import { ChevronDown, Wallet } from 'lucide-react'
import { useWallet } from '@pine/react'
import { explorerAddressUrl, formatAmount, shortHash } from '@pine/core'
import { CHAINS } from '@pine/core/chains'
import { useClipboard } from '@/components/ui/copy'
import { cn } from '@/lib/cn'

export function WalletButton({ className }: { className?: string }) {
  const w = useWallet()
  const { copy, copied } = useClipboard()

  if (!w.isConnected || !w.address) {
    return (
      <button
        type="button"
        onClick={() => w.connect()}
        className={cn(
          'inline-flex h-9 items-center gap-2 rounded-sm border border-rule-strong bg-sheet px-3 text-sm font-bold shadow-[0_2px_0_var(--color-rule)] hover:bg-bond',
          className,
        )}
      >
        <Wallet aria-hidden className="size-4" />
        Connect wallet
      </button>
    )
  }

  const chain = w.chainId ? CHAINS[w.chainId] : undefined
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-9 items-center gap-2 rounded-sm border border-rule-strong bg-sheet px-2.5 text-sm font-bold hover:bg-bond',
            className,
          )}
        >
          <span aria-hidden className={cn('size-2 rounded-full', w.isDemo ? 'bg-flag ring-1 ring-ochre' : 'bg-violet')} />
          <span className="font-mono text-[13px] font-normal">{shortHash(w.address, 4)}</span>
          {w.isDemo ? <span className="rounded-xs bg-wheat px-1 text-xs text-ochre">demo</span> : null}
          <ChevronDown aria-hidden className="size-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 w-[18rem] border border-rule bg-sheet p-1 shadow-[0_8px_24px_rgba(26,29,43,0.14)]"
        >
          <div className="px-3 py-2">
            <p className="text-sm text-graphite">{w.isDemo ? 'Simulated wallet' : 'Connected wallet'}</p>
            <p className="font-mono text-[13px] break-all">{w.address}</p>
            <p className="mt-1 text-sm">
              {chain ? chain.name : `Chain ${w.chainId ?? '?'}`}
              {w.balance ? (
                <>
                  {' '}
                  <span className="text-graphite">holds</span> {formatAmount(w.balance.amount, { symbol: w.balance.symbol, maxDecimals: 2 })}
                </>
              ) : null}
            </p>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-rule" />
          <DropdownMenu.Item
            onSelect={(e) => {
              e.preventDefault()
              void copy(w.address!)
            }}
            className="block cursor-pointer px-3 py-2 outline-none data-[highlighted]:bg-violet-wash data-[highlighted]:text-violet"
          >
            {copied ? 'Address copied' : 'Copy address'}
          </DropdownMenu.Item>
          {w.chainId && !w.isDemo ? (
            <DropdownMenu.Item asChild>
              <a
                href={explorerAddressUrl(w.chainId, w.address)}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="block px-3 py-2 no-underline outline-none data-[highlighted]:bg-violet-wash data-[highlighted]:text-violet"
              >
                View on block explorer
              </a>
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item
            onSelect={() => w.disconnect()}
            className="block cursor-pointer px-3 py-2 outline-none data-[highlighted]:bg-red-wash data-[highlighted]:text-red"
          >
            Disconnect
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
