'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useWalletSessionGuard } from '@pine/react'
import { shortAddress } from './wallet-display'

/**
 * SEC-AUTH-13 in the shell (`api` mode): a Pine session belongs to the wallet that signed in, so it ends when the wallet
 * switches to another account. Says so once; the account page shows it in place instead.
 */
export function SessionWalletGuard() {
  const change = useWalletSessionGuard()
  const router = useRouter()
  const pathname = usePathname()
  const announced = useRef(0)
  useEffect(() => {
    if (!change || change.state === 'signing_out' || announced.current >= change.seq) return
    announced.current = change.seq
    if (pathname === '/account') return
    toast(change.state === 'signed_out' ? 'Signed out of Pine' : 'Sign-out could not be confirmed', {
      description: `Your wallet switched to ${shortAddress(change.to)}. A session belongs to the wallet that signed in.`,
      action: { label: 'Sign in', onClick: () => router.push('/account') },
    })
  }, [change, pathname, router])
  return null
}
