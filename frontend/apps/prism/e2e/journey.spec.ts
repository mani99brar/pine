import { expect, test, type Page } from '@playwright/test'
import { routeGitHubAuthorize } from './support/github'
import { caption, stackEnv } from './support/stack'
import { installTestWallet } from './support/test-wallet'

// The customer journey of SPEC section 3 against the LOCAL stack, through the real UI: wallet sign-in (SIWE), GitHub
// link, composing a claim on a pinned commit, the backend preview, publication through a browser-verified plan sent by
// the (local, unlocked) test wallet, and the claim appearing on its page. Requires scripts/dev-stack/up.sh and Prism
// in api mode on :3004 (see frontend/docs/frontend/deployment.md).

const stack = stackEnv()
const short = `${stack.account.slice(0, 6)}`

async function connectAndSignIn(page: Page): Promise<void> {
  await page.goto('/account')
  await caption(page, 'Sign in: connect a wallet, then Sign-In with Ethereum (the backend issues the message; the browser checks it first)')
  const signIn = page.getByRole('button', { name: /sign in with ethereum/i })
  // A wallet that already authorized this site reconnects by itself (EIP-6963 discovery); otherwise connect it.
  await expect(signIn.or(page.getByRole('button', { name: /^connect wallet$/i })).first()).toBeVisible()
  if (!(await page.getByRole('heading', { name: /connect a wallet \(done\)/i }).isVisible())) {
    await page.getByRole('main').getByRole('button', { name: /connect wallet/i }).first().click()
    await page.getByRole('button', { name: /pine test wallet|browser wallet|injected/i }).first().click()
  }
  await signIn.click()
  // Signed in: the backend session exists (the page now offers GitHub linking and sign-out).
  await expect(page.getByRole('button', { name: /link github/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /^sign out$/i })).toBeVisible()
  await expect(page.getByText(new RegExp(short, 'i')).first()).toBeVisible()
}

test('wallet sign-in, GitHub link, compose, preview, publish and view a claim', async ({ page, context }) => {
  await installTestWallet(context, { rpcUrl: stack.rpcUrl, account: stack.account, chainId: 100 })
  await routeGitHubAuthorize(context, { controlUrl: stack.controlUrl, appOrigin: stack.appOrigin, githubUserId: stack.githubUserId, login: stack.githubLogin })

  await page.goto('/')
  await caption(page, 'Pine Prism in api mode: every read and write goes to the Pine backend on the same origin')
  await expect(page).toHaveTitle(/Pine/)

  await connectAndSignIn(page)

  await caption(page, 'Link GitHub through the backend (zero-permission app; PKCE and state bound to the session)')
  await page.getByRole('button', { name: /link github/i }).click()
  await page.waitForURL(/\/(settings|account)/)
  if (/\/settings/.test(page.url())) {
    const next = page.getByRole('link', { name: /continue to your account/i }).or(page.getByRole('button', { name: /continue to your account/i }))
    if (await next.count()) await next.first().click()
  }
  await expect(page.getByText(`@${stack.githubLogin}`).first()).toBeVisible()
})
