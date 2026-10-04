import { expect, test } from '@playwright/test'
import { connectAndSignIn } from './support/journey-steps'
import { stackEnv } from './support/stack'
import { installTestWallet } from './support/test-wallet'

// Reloads with an extension-like wallet that is slow to wake up: right after each page load it answers eth_accounts
// with [] for 1.5 s (MetaMask's service worker, Brave Wallet loading its keyring). wagmi tries to reconnect only once, at
// mount, so before WalletReconnect every reload showed "Connect wallet" while the backend session was still signed in.

const stack = stackEnv()
const short = stack.account.slice(0, 6)

test('a wallet that wakes up slowly after a reload stays connected and signed in, on every page', async ({ page, context }) => {
  await installTestWallet(context, { rpcUrl: stack.rpcUrl, account: stack.account, chainId: 100, wakeMs: 1_500 })
  await connectAndSignIn(page)
  const logouts: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/auth/logout')) logouts.push(r.url())
  })
  const header = page.getByRole('banner')

  for (const path of ['/account', '/claims', '/compose', '/policies', '/account']) {
    await page.goto(path)
    await expect(header.getByText(new RegExp(short, 'i')).first()).toBeVisible({ timeout: 20_000 })
    await expect(header.getByRole('button', { name: /^connect wallet$/i })).toHaveCount(0)
  }
  await page.reload()
  await expect(header.getByText(new RegExp(short, 'i')).first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('status').filter({ hasText: /signed in as/i }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: /sign in with ethereum/i })).toHaveCount(0)
  expect(logouts).toEqual([])
})
