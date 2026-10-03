import { expect, test } from '@playwright/test'
import { routeGitHubAuthorize } from './support/github'
import { commitSealedEvidence, composeAndPublish, connectAndSignIn, linkGitHub } from './support/journey-steps'
import { caption, stackEnv } from './support/stack'
import { installTestWallet } from './support/test-wallet'

// The customer journey of SPEC section 3 against the LOCAL stack, through the real UI: wallet sign-in (SIWE), GitHub
// link, composing a claim on a pinned commit, the backend preview, publication through a browser-verified plan sent by
// the (local, unlocked) test wallet, the claim on its page, and sealed evidence on it. Requires scripts/dev-stack/up.sh
// and Prism in api mode on :3004 (see frontend/docs/frontend/deployment.md).

const stack = stackEnv()
test.describe.configure({ mode: 'serial' })

let published: string | null = null

/** A claim whose evidence window is open: the one published earlier in this run, else the newest listed one. */
async function openClaim(): Promise<string> {
  if (published) return published
  const res = await fetch(`${stack.appOrigin}/api/v1/claims?phase=evidence_open&limit=5`)
  const body = (await res.json()) as { items: { market: string }[] }
  const market = body.items[0]?.market
  if (!market) throw new Error('no claim with an open evidence window on the local stack (run scripts/dev-stack/smoke.mjs once)')
  return market
}

test('wallet sign-in, GitHub link, compose, preview, publish and view a claim', async ({ page, context }) => {
  await installTestWallet(context, { rpcUrl: stack.rpcUrl, account: stack.account, chainId: 100 })
  await routeGitHubAuthorize(context, { controlUrl: stack.controlUrl, appOrigin: stack.appOrigin, githubUserId: stack.githubUserId, login: stack.githubLogin })

  await page.goto('/')
  await caption(page, 'Pine Prism in api mode: every read and write goes to the Pine backend on the same origin')
  await expect(page).toHaveTitle(/Pine/)
  await connectAndSignIn(page)
  await linkGitHub(page)
  published = await composeAndPublish(page)
})

test('sealed evidence: commit through a browser-verified plan, then see the commitment to reveal', async ({ page, context }) => {
  await installTestWallet(context, { rpcUrl: stack.rpcUrl, account: stack.account, chainId: 100 })
  const market = await openClaim()
  await connectAndSignIn(page)
  await commitSealedEvidence(page, market)
})
