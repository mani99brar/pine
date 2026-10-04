'use client'

import Link from 'next/link'
import { Popover } from 'radix-ui'
import { usePine, usePineSession, useWallet, useWalletRestoring } from '@pine/react'
import { formatAmount, shortHash } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { Wallet } from 'lucide-react'
import { useMounted } from '@/lib/hooks'
import { cn } from '@/lib/cn'
import { HashChip } from '@/components/ui/interactive'

/** `api` mode: whether this wallet is the one signed in to Pine (connecting a wallet does not sign in). */
function PineSessionLine({ address }: { address: string }) {
  const session = usePineSession()
  if (session.status === 'loading' || session.status === 'disabled') return null
  if (!session.session) {
    return (
      <p className="mt-3 text-[0.8125rem] text-lumen-2">
        Not signed in to Pine.{' '}
        <Popover.Close asChild>
          <Link href="/account" className="link">
            Sign in
          </Link>
        </Popover.Close>
      </p>
    )
  }
  return session.session.wallet.toLowerCase() === address.toLowerCase() ? (
    <p className="mt-3 text-[0.8125rem] text-lumen-2">Signed in to Pine with this wallet.</p>
  ) : (
    <p className="mt-3 text-[0.8125rem] text-na">This is not the wallet you signed in with, so Pine is signing you out.</p>
  )
}

export function WalletButton({ className, block }: { className?: string; block?: boolean }) {
  const mounted = useMounted()
  const w = useWallet()
  const restoring = useWalletRestoring()
  const { env } = usePine()
  if (!mounted) {
    return <span className={cn('skeleton inline-block h-9 w-32', block && 'w-full', className)} aria-hidden />
  }
  if ((!w.isConnected || !w.address) && restoring && !w.isDemo) {
    // A wallet connected before this load is still waking up (a slow extension): not "disconnected" yet.
    return (
      <span role="status" className={cn('btn btn-glass btn-sm cursor-default gap-2', block && 'w-full', className)}>
        <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-lumen-3" />
        <span className="text-[0.78rem] text-lumen-2">Reconnecting wallet</span>
      </span>
    )
  }
  if (!w.isConnected || !w.address) {
    return (
      <button type="button" onClick={() => w.connect()} className={cn('btn btn-glass btn-sm', block && 'w-full', className)}>
        <Wallet size={15} aria-hidden />
        {w.isDemo ? 'Connect demo wallet' : 'Connect wallet'}
      </button>
    )
  }
  const chain = getChainOrDefault(w.chainId)
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={cn('btn btn-glass btn-sm gap-2', block && 'w-full justify-start', className)} aria-label={`Wallet ${w.address}${w.isDemo ? ' (demo)' : ''}`}>
          <span aria-hidden className="h-2 w-2 rounded-full bg-hb shadow-[0_0_10px_rgba(90,216,255,0.8)]" />
          <span className="t-code text-[0.78rem] text-lumen">{shortHash(w.address)}</span>
          {w.balance && <span className="hidden text-[0.78rem] font-medium text-lumen-3 xl:inline">{formatAmount(w.balance.amount, { maxDecimals: 2 })} {w.balance.symbol}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} className="glass-float cut-lg z-[80] w-[19rem] p-4 focus:outline-none">
          <p className="text-[0.8125rem] text-lumen-3">{w.isDemo ? 'Simulated demo wallet. No real funds move.' : 'Connected wallet'}</p>
          <HashChip value={w.address} label="Address" className="mt-2 w-full" />
          <dl className="mt-3 grid grid-cols-2 gap-2 text-[0.84375rem]">
            <div className="cut-sm border border-edge bg-void px-3 py-2">
              <dt className="text-lumen-3">Collateral</dt>
              <dd className="tnum mt-0.5 text-lumen">{w.balance ? `${formatAmount(w.balance.amount, { maxDecimals: 2 })} ${w.balance.symbol}` : 'Unknown'}</dd>
            </div>
            <div className="cut-sm border border-edge bg-void px-3 py-2">
              <dt className="text-lumen-3">Gas</dt>
              <dd className="tnum mt-0.5 text-lumen">{w.nativeBalance ? `${formatAmount(w.nativeBalance.amount, { maxDecimals: 3 })} ${w.nativeBalance.symbol}` : 'Unknown'}</dd>
            </div>
          </dl>
          <p className="mt-3 text-[0.8125rem] text-lumen-3">Network: {chain.name}</p>
          {env.dataSource === 'api' && <PineSessionLine address={w.address} />}
          <button type="button" onClick={() => w.disconnect()} className="btn btn-ghost btn-sm mt-3 w-full">
            Disconnect
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
