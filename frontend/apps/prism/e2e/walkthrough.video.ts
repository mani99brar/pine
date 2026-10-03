import { writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { routeGitHubAuthorize } from './support/github'
import { commitSealedEvidence, composeAndPublish, connectAndSignIn, linkGitHub } from './support/journey-steps'
import { caption, stackEnv, titleCard } from './support/stack'
import { installTestWallet } from './support/test-wallet'

// The recorded demo: the same journey as journey.spec.ts in one continuous page, with title cards and captions.
// Run: npx playwright test -c e2e/playwright.video.config.ts (local stack + Prism in api mode on :3004).

const stack = stackEnv()

test('walkthrough: Pine Prism on the Pine backend', async ({ page, context }, info) => {
  // Seconds since the recording started, per step: scripts/make-video.mjs speeds up the long on-chain waits.
  const started = Date.now()
  const marks: { label: string; t: number }[] = []
  const mark = (label: string) => marks.push({ label, t: (Date.now() - started) / 1000 })
  await installTestWallet(context, { rpcUrl: stack.rpcUrl, account: stack.account, chainId: 100 })
  await routeGitHubAuthorize(context, { controlUrl: stack.controlUrl, appOrigin: stack.appOrigin, githubUserId: stack.githubUserId, login: stack.githubLogin })

  await titleCard(
    page,
    'Pine Prism, connected to the Pine backend',
    [
      'The web app reads and writes through pine-api on the same origin (/api/v1).',
      'Local integration stack: anvil fork of Gnosis with Pine deployed, PostgreSQL, pine-api, native indexer.',
      'Real flows: SIWE session, GitHub link through the backend, transaction plans verified in the browser.',
    ],
    5000,
  )

  await page.goto('/claims?view=list')
  await caption(page, 'The light table lists the claims indexed from the chain, served by the backend')
  await page.waitForTimeout(1500)
  await page.goto('/policies/FUNC-001')
  await caption(page, 'Policies come from the backend catalog: each claim pins the policy text by its sha256')
  await page.waitForTimeout(1200)

  await connectAndSignIn(page)
  await linkGitHub(page)
  mark('compose')
  const market = await composeAndPublish(page, mark)
  mark('published')
  await page.mouse.wheel(0, 700)
  await page.waitForTimeout(1500)
  mark('evidence')
  await commitSealedEvidence(page, market, mark)
  mark('evidence-done')
  await page.locator('#sealed').scrollIntoViewIfNeeded()
  await caption(page, 'Sealed evidence is on chain; its salt stays in this browser until the reveal')
  await page.waitForTimeout(1500)

  await titleCard(
    page,
    'Done: the production paths, end to end',
    [
      'Sign-in, GitHub link, compose, browser-verified preview, publish, live claim, sealed evidence.',
      'Every wallet prompt came from a backend plan the browser verified against the pinned deployment.',
      'Recorded against a local fork: no real network, keys or funds were used.',
    ],
    5000,
  )
  mark('end')
  writeFileSync(info.outputPath('timeline.json'), JSON.stringify(marks, null, 2))
  expect(market).toMatch(/^0x[0-9a-f]{40}$/)
})
