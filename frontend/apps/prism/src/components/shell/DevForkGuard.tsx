'use client'

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { formatUnits } from 'viem'
import { useAccount } from 'wagmi'
import { forkFixHint, forkStatusMessage, useDevForkWallet, walletRequestOf, type DevFundingResult } from '@pine/react'
import { shortAddress } from './wallet-display'

function fundedToast(result: DevFundingResult) {
  const balance = Number(formatUnits(result.balanceWei, 18)).toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (result.funded) {
    toast.success('Test funds on the local fork', {
      description: `${shortAddress(result.address)} now holds ${balance} test xDAI on the local Gnosis fork (gas, budgets and bonds are paid in xDAI). Nothing touched a real network.`,
    })
  } else {
    toast('Local fork wallet ready', { description: `${shortAddress(result.address)} already holds ${balance} test xDAI on the local fork.` })
  }
  if (result.warning) toast.warning('Delegated wallet', { description: result.warning })
}

/**
 * LOCAL DEVELOPMENT ONLY (renders nothing unless the build is a dev-fork build, see @pine/react `devForkConfig`).
 * Funds a connected wallet on the local anvil fork, and shows a persistent, non-dismissible strip whenever the wallet's
 * own network is not the fork: sending is then blocked by the transaction runner.
 */
export function DevForkGuard() {
  const { connector } = useAccount()
  const fork = useDevForkWallet({
    onFunded: fundedToast,
    onFundingFailed: (message) => toast.warning('Local dev faucet unavailable', { description: message }),
  })
  const [adding, setAdding] = useState(false)
  const config = fork.config

  const addNetwork = useCallback(async () => {
    if (!config) return
    setAdding(true)
    try {
      const request = await walletRequestOf(connector)
      if (!request) throw new Error('No wallet provider is connected.')
      await request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: `0x${config.chainId.toString(16)}`,
            chainName: 'Gnosis (local fork)',
            nativeCurrency: { name: 'xDAI', symbol: 'XDAI', decimals: 18 },
            rpcUrls: [new URL(config.rpcUrl).origin],
          },
        ],
      })
      toast('Wallet network updated', { description: 'If your wallet kept its existing Gnosis RPC, select the local one by hand.' })
    } catch (e) {
      toast.warning('Your wallet did not add the fork RPC', { description: `${e instanceof Error ? e.message.slice(0, 160) : 'Rejected.'} ${forkFixHint(config)}` })
    } finally {
      setAdding(false)
    }
  }, [config, connector])

  if (!config || !fork.check || fork.status === 'fork') return null
  return (
    <div role="alert" className="relative z-[61] border-b border-[rgba(255,107,131,0.55)] bg-[#2a1216]">
      <div className="relative mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-6 lg:px-8">
        <p className="min-w-0 flex-1 text-[0.8125rem] leading-[1.45] text-lumen sm:text-[0.84375rem]">
          <span className="tag mr-2 border-[rgba(255,107,131,0.55)] text-ha">Local dev</span>
          <strong className="font-semibold">{forkStatusMessage(fork.check, config)} Sending is blocked.</strong>{' '}
          <span className="text-lumen-2">{forkFixHint(config)}</span>
        </p>
        <button
          type="button"
          onClick={() => void addNetwork()}
          disabled={adding}
          className="inline-flex h-8 shrink-0 items-center rounded-[4px] border border-[rgba(255,107,131,0.55)] px-3 text-[0.8125rem] font-semibold text-lumen hover:bg-smoke-3 disabled:opacity-60"
        >
          {adding ? 'Asking your wallet…' : 'Add the fork RPC to my wallet'}
        </button>
      </div>
    </div>
  )
}
