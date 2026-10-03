import { expect, test, type Page } from '@playwright/test'
import { routeGitHubAuthorize } from './support/github'
import { caption, stackEnv } from './support/stack'
import { installTestWallet } from './support/test-wallet'

// The customer journey of SPEC section 3 against the LOCAL stack, through the real UI: wallet sign-in (SIWE), GitHub
// link, composing a claim on a pinned commit, the backend preview, publication through a browser-verified plan sent by
// the (local, unlocked) test wallet, and the claim appearing on its page. Requires scripts/dev-stack/up.sh and Prism
// in api mode on :3004 (see frontend/docs/frontend/deployment.md).

const stack = stackEnv()
test.describe.configure({ mode: 'serial' })
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

  // Compose: pin an exact commit of a pull request, choose a policy, state one bounded claim.
  await page.goto('/compose')
  await page.waitForURL(/draft=/)
  await page.locator('#source-input').waitFor()
  await caption(page, 'Compose: the repository browser reads GitHub through the backend (linked account, public repositories)')
  await page.locator('#source-input').fill('pine-labs/keeper-bot')
  await page.getByRole('button', { name: /use pull request.*#12/i }).click()
  await expect(page.getByText(/Membership: pull request #12/)).toBeVisible()
  await page.getByRole('button', { name: 'Use this commit' }).click()
  await expect(page.getByText('Pinned. Continue when you are ready.')).toBeVisible()
  await page.getByRole('button', { name: /Continue to policy/ }).click()
  await caption(page, 'Policies come from the backend catalog; the claim pins the policy text by its sha256')
  await page.getByRole('radio', { name: /FUNC-001@0\.1\.0/ }).click()
  await page.getByRole('button', { name: /Continue to claim/ }).click()

  const title = `Keeper retry budget caps reverted transactions per epoch ${new Date().toISOString().slice(11, 19)}`
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('Requirement').fill('The keeper must not submit more than the configured retry budget of transactions per epoch, even when every attempt reverts.')
  await page.getByLabel('Violation').fill('the keeper submits more transactions in one epoch than its retry budget allows')
  await page.locator('#in-scope').fill('src/keeper/retry-budget.ts')
  await page.locator('#in-scope').press('Enter')
  await page.getByLabel('Fault model').fill('RPC errors and reverted transactions; no corruption of the keeper state.')
  await page.getByLabel('Allowed inputs').fill('Any keeper configuration and any sequence of RPC responses.')
  await page.getByRole('button', { name: /Continue to environment/ }).click()
  await page.getByLabel('Runtime').fill('node 22.14.0')
  await page.getByLabel('External state').fill('none')
  await page.getByLabel('Reproduction command').fill('pnpm vitest run test/retry-budget.spec.ts')
  await page.getByLabel('Dependency notes').fill('pnpm 10 with the lockfile in the repository')
  await page.getByRole('button', { name: /Continue to deadlines/ }).click()
  await caption(page, 'Deadlines: the evidence window is yours (3 to 30 days); reveal and oracle opening are fixed by Pine')
  await page.getByRole('button', { name: /Continue to funding/ }).click()
  await page.getByRole('button', { name: /Continue to review/ }).click()

  // Review: the backend freezes the claim document; the browser re-derives its digest, CID and question before showing it.
  await page.getByRole('checkbox', { name: /^I attest/ }).check()
  await page.getByRole('button', { name: 'Preview the claim' }).click()
  await expect(page.getByRole('heading', { name: "Pine's preview" })).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText('Verified in this browser')).toBeVisible()
  await caption(page, 'The preview is verified in this browser: document sha256 and CID, the on-chain question, the policy digest')
  await page.getByRole('checkbox', { name: /I have read these disclosures/ }).check()
  await page.getByRole('button', { name: /Continue to publish/ }).click()

  // Publish: one createClaim plan, decoded and compared with the previewed document, sent by the wallet.
  await caption(page, 'Publish: the createClaim plan is decoded and compared with the previewed document before the wallet signs')
  await page.getByRole('button', { name: 'Publish and seal' }).click()
  await expect(page.getByRole('heading', { name: 'Your claim is on the light table.' })).toBeVisible({ timeout: 300_000 })
  const href = await page.getByRole('link', { name: 'Watch it live' }).getAttribute('href')
  expect(href).toMatch(/^\/claims\/0x[0-9a-f]{40}$/)
  published = (href ?? '').split('/').pop() ?? null
  await page.getByRole('link', { name: 'Watch it live' }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 60_000 })
  await caption(page, 'Live: ClaimRegistry created the Seer market; the indexer and the backend serve it back')
})

/** A claim whose evidence window is open: the one published earlier in this run, else the newest listed one. */
async function openClaim(): Promise<string> {
  if (published) return published
  const res = await fetch(`${stack.appOrigin}/api/v1/claims?phase=evidence_open&limit=5`)
  const body = (await res.json()) as { items: { market: string }[] }
  const market = body.items[0]?.market
  if (!market) throw new Error('no claim with an open evidence window on the local stack (run scripts/dev-stack/smoke.mjs once)')
  return market
}

let published: string | null = null

test('sealed evidence: commit through a browser-verified plan, then see the commitment to reveal', async ({ page, context }) => {
  await installTestWallet(context, { rpcUrl: stack.rpcUrl, account: stack.account, chainId: 100 })
  const market = await openClaim()
  await connectAndSignIn(page)

  await page.goto(`/claims/${market}`)
  await caption(page, 'A published claim: terms from the verified claim document, deadlines with their exact operators')
  await page.getByRole('link', { name: /submit evidence/i }).first().click()
  await page.waitForURL(new RegExp(`/claims/${market}/evidence`))
  await caption(page, 'Sealed evidence: the commitment is computed in the browser; the salt never leaves it before the reveal')

  await page.getByLabel('Title', { exact: true }).fill('Reporter deposit drawn from the gas reserve under retry')
  await page.getByLabel('Requirement violated').fill('Reporter-deposit principal must not be funded from the operator gas reserve.')
  await page.getByLabel('Summary', { exact: true }).fill('Replaying the journal with two failed reports makes the planner fund the third deposit from the gas reserve.')
  await page.getByLabel('Expected behavior').fill('The planner refuses to fund the deposit from the gas reserve.')
  await page.getByLabel('Actual behavior').fill('The deposit is funded from the gas reserve after the second retry.')
  await page.getByLabel('Environment', { exact: true }).fill('node 22.14.0, pnpm 10.9.2, the pinned commit')
  await page.getByLabel('Setup', { exact: true }).fill('pnpm install --frozen-lockfile')
  await page.getByLabel('Command', { exact: true }).fill('pnpm vitest run test/reporter-retry.spec.ts')
  await page.getByLabel('Attachments').setInputFiles({ name: 'repro-log.txt', mimeType: 'text/plain', buffer: Buffer.from('retry 1: failed\nretry 2: failed\nretry 3: funded from gas reserve\n') })

  await page.getByRole('button', { name: /commit sealed evidence/i }).click()
  await caption(page, 'The backend proposes the plan; the browser verifies it (allowlist, pinned deployment, commitment) before the wallet signs')
  // The commitment is recorded on chain and listed for the reveal.
  await expect(page.locator('#sealed').getByText(/commitment/i).first()).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('button', { name: /reveal sealed evidence/i }).first()).toBeVisible({ timeout: 120_000 })
})
