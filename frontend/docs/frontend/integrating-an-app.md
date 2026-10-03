# Integrating a Pine app with `@pine/react` and `@pine/server`

This guide lists the exact files a Next.js 16 app needs. It also covers the decisions the shared layer makes for you. Copy the blocks as they are. Every app (`console`, `docket`, `field`) mounts the same routes, so the agent API, auth and GitHub proxy behave identically everywhere.

**Route status** (updated by the platform agent):

| Route | Handler | Status |
|---|---|---|
| `/api/auth/*` | `createAuth().handlers` | live |
| `/api/github/*` | `createGitHubHandler(auth)` | live (mock source in mock mode, live GitHub with the user's token) |
| `/api/account/*` | `createAccountHandler(auth)` | live (signed-cookie store in mock/envio, REST in rest mode; `api-token` for REST auth) |
| `/api/agent/*` | `createAgentHandler({ appName })` | live (needs `@pine/core/agent`) |
| `/api/ipfs` | `createIpfsHandler({ auth })` | live (deterministic mock CID without `PINE_IPFS_UPLOAD_URL`) |
| `/llms.txt`, `/llms-full.txt`, `/.well-known/pine.json` | `llmsTxtHandler`, `llmsFullTxtHandler`, `wellKnownHandler` | live |

## 1. Rules

- `@pine/server` is server-only. Import it only from `src/auth.ts` and `route.ts` files, never from a `'use client'` file. The package throws if it is evaluated in a browser.
- `@pine/react` is client-only. Every hook module is marked `'use client'`. You can render `PineProviders` from a client wrapper (recommended) or directly from the server layout.
- `next.config.ts` must keep `transpilePackages: ['@pine/core', '@pine/data', '@pine/react', '@pine/server']`.
- Route handler `params` are Promises in Next 16. The handlers already accept `{ params: Promise<{ path?: string[] }> }`, so a one-line re-export is enough.

## 2. Environment

Everything works with no env vars (mock mode, demo wallet, demo sign-in). `.env.example` lists the full set:

| Var | Effect |
|---|---|
| `NEXT_PUBLIC_PINE_DATA_SOURCE` | `mock` (default), `rest` or `envio`. If `rest`/`envio` is set without its URL, the app falls back to `mock`. |
| `NEXT_PUBLIC_PINE_API_URL` / `NEXT_PUBLIC_ENVIO_GRAPHQL_URL` | Indexer endpoints |
| `NEXT_PUBLIC_CHAIN_ID` | Default chain (100, Gnosis) |
| `NEXT_PUBLIC_PINE_DEMO_WALLET` | `1` forces the simulated wallet. It is on automatically in mock mode, and `0` turns it off. |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Optional. Without it, wagmi uses injected wallets only (EIP-6963), and the app still works. |
| `NEXT_PUBLIC_RPC_URL_100`, `_1`, `_11155111` | Optional RPC overrides |
| `NEXT_PUBLIC_SITE_URL` | Absolute URL used in agent briefs, llms.txt and feeds. Defaults to the request origin. |
| `AUTH_SECRET` | Required in production unless the app runs in mock mode without GitHub OAuth. Missing in dev/mock: a deterministic dev secret is used and a warning is printed. |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | Enables GitHub sign-in (scope `read:user`). Set `NEXT_PUBLIC_PINE_GITHUB_OAUTH=1` too, so the client shows the GitHub button. |
| `PINE_IPFS_UPLOAD_URL`, `PINE_IPFS_UPLOAD_TOKEN` | Server-side pinning. Without them, `/api/ipfs` returns a deterministic CID and pins nothing. |
| `PINE_GITHUB_SOURCE` | Optional `mock` or `live`, to force the GitHub proxy source |
| `PINE_API_TOKEN` | Rest mode, optional. A static service token the server sends to the REST API instead of per-user tokens. |

Read the config in client code with `usePine().env` and in server code with `readServerEnv()` from `@pine/server`.

## 3. Files to create

### `src/auth.ts`

```ts
import { createAuth } from '@pine/server/auth'

export const { handlers, auth, signIn, signOut } = createAuth({ appName: 'Pine Prism' })
```

`createAuth` also returns `providers: { github, demo }`, which a server-rendered sign-in UI can use. Importing `@pine/server/auth` augments next-auth's `Session` type, so `session.user.login`, `avatarUrl`, `scopes`, `demo` and `provider` are typed. The GitHub access token is never in the session.

### `src/app/api/auth/[...nextauth]/route.ts`

```ts
import { handlers } from '@/auth'

export const { GET, POST } = handlers
```

### `src/app/api/github/[...path]/route.ts`

```ts
import { auth } from '@/auth'
import { createGitHubHandler } from '@pine/server/github'

export const { GET } = createGitHubHandler(auth)
```

### `src/app/api/account/[...path]/route.ts`

```ts
import { auth } from '@/auth'
import { createAccountHandler } from '@pine/server/siwe'

export const { GET, POST, PATCH, DELETE } = createAccountHandler(auth)
```

### `src/app/api/agent/[...path]/route.ts`

```ts
import { createAgentHandler } from '@pine/server/agent'

export const { GET, OPTIONS } = createAgentHandler({ appName: 'Pine Prism' })
```

### `src/app/api/ipfs/route.ts`

```ts
import { auth } from '@/auth'
import { createIpfsHandler } from '@pine/server/ipfs'

export const { POST } = createIpfsHandler({ auth })
```

### `src/app/llms.txt/route.ts`

```ts
import { llmsTxtHandler } from '@pine/server/agent'

export const { GET } = llmsTxtHandler({ appName: 'Pine Prism' })
```

### `src/app/llms-full.txt/route.ts`

```ts
import { llmsFullTxtHandler } from '@pine/server/agent'

export const { GET } = llmsFullTxtHandler({ appName: 'Pine Prism' })
```

### `src/app/.well-known/pine.json/route.ts`

```ts
import { wellKnownHandler } from '@pine/server/agent'

export const { GET } = wellKnownHandler({ appName: 'Pine Prism' })
```

The agent, llms and well-known routes read the request, so Next treats them as dynamic. If you prefer, add `export const dynamic = 'force-dynamic'` to make that explicit.

### `src/app/providers.tsx` (client wrapper)

```tsx
'use client'

import type { ReactNode } from 'react'
import type { Session } from 'next-auth'
import { lightTheme } from '@rainbow-me/rainbowkit'
import { PineProviders } from '@pine/react'

const rainbowTheme = lightTheme({ accentColor: '#1c5d50', borderRadius: 'small', fontStack: 'system' })

export function Providers({ children, session }: { children: ReactNode; session: Session | null }) {
  return (
    <PineProviders appName="Pine Prism" session={session} rainbowTheme={rainbowTheme}>
      {children}
    </PineProviders>
  )
}
```

Create the RainbowKit theme in a client file. The RainbowKit module is a client module, so a server component cannot call `lightTheme()`.

### `src/app/layout.tsx`

```tsx
import '@rainbow-me/rainbowkit/styles.css'
import './globals.css'
import { auth } from '@/auth'
import { Providers } from './providers'

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers session={session}>{children}</Providers>
      </body>
    </html>
  )
}
```

Passing `await auth()` means the first render already knows the user. It also makes the layout dynamic because it reads cookies. If a static shell matters more, pass `session={undefined}`; `SessionProvider` then fetches `/api/auth/session` on the client.

### Turbopack alias for optional x402 peers (recommended)

**Status: recommended for every app until a source fix is confirmed.** Without it, Turbopack fails with `Module not found: @x402/core/client` in any app that imports `@pine/react`.

**Why the alias is needed:**

- `@rainbow-me/rainbowkit`'s root entry imports the `wagmi/connectors` barrel. Pine needs that entry for `RainbowKitProvider` and `useConnectModal`.
- That barrel re-exports the Base Account connector, which does `import('@base-org/account')`.
- That pulls in `@coinbase/cdp-sdk`, which lazily imports optional `@x402/*` payment packages that are not installed.

Turbopack resolves dynamic imports at build time, so the chain is reached even though Pine never uses those packages. `@pine/react` no longer configures Base Account or Coinbase Wallet: its wagmi config uses `connectorsForWallets` with injected, MetaMask, Rabby, Rainbow, Safe and WalletConnect, the last only when a project id is set. Those code paths never run. The import graph still reaches the module through RainbowKit itself, which is why each app needs the alias.

A source fix was investigated, and the alias is the chosen fix. Of RainbowKit's entries, only `@rainbow-me/rainbowkit/components` avoids the barrel. The root entry is needed for `useConnectModal`, `lightTheme`/`darkTheme` and `connectorsForWallets`, and `./wallets` and wagmi's `walletConnect` connector all go through `wagmi/connectors`. A barrel-free build would therefore drop WalletConnect and the theme helpers.

Use the exact pattern from `apps/prism/next.config.ts`:

```ts
// next.config.ts
import type { NextConfig } from 'next'

// Optional x402 payment modules lazily imported by @coinbase/cdp-sdk (via RainbowKit's Base Account
// connector) are not installed; Pine never calls them. Alias them to an empty module so bundling succeeds.
const X402_OPTIONAL = [
  '@x402/core/client',
  '@x402/core/schemas',
  '@x402/core/server',
  '@x402/evm',
  '@x402/evm/auth-capture/client',
  '@x402/evm/batch-settlement/client',
  '@x402/evm/exact/client',
  '@x402/evm/exact/server',
  '@x402/evm/exact/v1/client',
  '@x402/evm/upto/client',
  '@x402/evm/upto/server',
  '@x402/express',
  '@x402/extensions/bazaar',
  '@x402/extensions/builder-code',
  '@x402/fetch',
  '@x402/svm/exact/client',
  '@x402/svm/exact/server',
  '@x402/svm/exact/v1/client',
  '@x402/svm/upto/client',
  '@x402/svm/upto/server',
]
const emptyShim = './src/lib/shims/x402.js'

const nextConfig: NextConfig = {
  turbopack: { resolveAlias: Object.fromEntries(X402_OPTIONAL.map((m) => [m, emptyShim])) },
  transpilePackages: ['@pine/core', '@pine/data', '@pine/react', '@pine/server'],
  // …the rest of your config
}

export default nextConfig
```

```js
// src/lib/shims/x402.js — stand-in for the optional @x402/* modules. Pine never uses x402 payments.
export {}
```

The minimal shim is the empty `export {}` above. If Turbopack reports missing named exports, use Prism's version, which exports throwing stubs for each name. Copy it from `apps/prism/src/lib/shims/x402.js`. If a newer `@coinbase/cdp-sdk` adds `@x402/*` specifiers, add them to the list.

## 4. What the hooks give you

All signatures are in [package-api.md](package-api.md). Behaviour worth knowing:

### Wallet

- `useWallet()` is the only wallet API apps need. In demo mode, `connect()` connects the simulated wallet (`DEMO_WALLET_ADDRESS`, balance `1250 sDAI` and `42.5 xDAI`, both reduced by simulated spending). Otherwise `connect()` opens the RainbowKit modal.
- `useDemoWallet().failNext(stepId?)` makes the next wallet prompt reject with "User rejected the request.", which exercises recovery. Without `stepId`, it applies to whichever wallet prompt comes next.

### Tx runner (`useTxRunner`, and the `runner` inside the publish, evidence and redeem hooks)

- **States.** `idle → running → done`. A failed step moves the runner to `failed`: `retry()` resumes from that step, and `skip(id)` skips it when the step is optional. After a reload, or while waiting on a manual step, the runner is `paused`, and `start()` continues.
- **Persistence.** Per-step status lives in `localStorage['pine:tx:<key>']`. On reload, steps that were `pending` with a tx hash are re-checked:
  - **Live mode:** the runner re-reads the receipt.
  - **Demo mode:** the step is confirmed once it is more than 5s old.

  The runner never auto-continues into a new wallet prompt.
- **Spending limit.** `start()` is blocked when the plan's collateral costs exceed `spendingLimit`. The runner then shows `runner.error`, and `runner.limit` holds `{ required, limit, currency, within }`. Each step is also checked against the remaining limit before its prompt. Gas costs in the native token do not count against the collateral limit.
- **Manual steps (new).** Seer sends liquidity provision to the DEX, so the `add_liquidity_yes`/`add_liquidity_no` steps carry no `request`. The runner treats them as manual. It pauses with `runner.awaitingManual = 'add_liquidity_yes'`, and the step has `manual: true` and `actionUrl`, which points to the Seer market page with its "Add liquidity" button. Render an "Open DEX" link and a "Mark done" button that calls `runner.confirmManual(stepId, txHash?)`. `add_liquidity_no` is optional, so `skip()` works on it. This applies in demo mode too.
- **Step fields.** Each step exposes `status`, `txHash`, `error`, `estimatedCost`, `freezesTerms`, `optional`, `manual` and `actionUrl`. Show `estimatedCost` against the remaining limit (`runner.limit`, `runner.spent`) before every prompt.

### Composer, drafts and publishing

- **`useClaimComposer(draftId?)`.** The draft lives in the TanStack Query cache and autosaves to the DraftStore 600 ms after the last edit. `question`, `manifest`, `manifestHash`, `validation` and `funding` are re-derived on every change.
  - Object patches merge `spec` and `funding` one level deep: `update({ spec: { title } })` keeps every other field. Use the function form for deep edits.
  - Once `create_market` confirms, `frozen` becomes true and source/spec edits are ignored. Once a funding step confirms, `fundingFrozen` becomes true.
- **Defaults.**
  - Evidence deadline: now + 72h, rounded up to the hour (UTC).
  - Oracle opening: deadline + 1h. It follows the deadline while it is still at that default offset.
  - Oracle timeout: **302 400 s (3.5 days)**. Seer's official MarketFactory fixes this value, so it is not editable, and `normalizeDraft` enforces it together with the chain's arbitrator and bond token.
  - Min bond: from the chain config (10 xDAI on Gnosis). Category: `misc`. Evidence mechanism: `erc1497-arbitrator-proxy`.
  - Funding: liquidity `25`, initial YES price `0.15`, price range `[0.02, 0.8]`. The spending limit comes from account preferences, or `50` when there are none.
- **Hash stability.** The manifest `claimId` is derived from the draft id (`pine-<draftid>`), and `createdAt` is the draft's creation time. The hash shown at review is therefore the hash that gets pinned. The manifest also includes `creator`, which is the connected wallet, so connect the wallet before showing the final hash.
- **`usePublishClaim(draftId)`** runs these steps in order:
  1. Pin the manifest. This fails if storage reports a different hash.
  2. Create the market. Terms freeze here.
  3. Approve exactly the liquidity amount.
  4. Split.
  5. Add Yes and No liquidity (manual steps).

  It returns `blockers: string[]`, which is non-empty for an invalid draft, a gated policy (SC-001), no wallet, or unverified contracts in live mode. `start()` refuses while blockers exist. Progress is mirrored into `draft.publication`, so dashboards can list partial publications from `useDrafts()` and link back to the publish stage. Mounting `usePublishClaim(draftId)` again resumes the same run.

  In demo mode, completion adds the claim to the MockDataProvider (it then appears in explore, dashboards and activity in this browser) and returns `claimId`. The server-side agent API reads its own in-memory mock, so demo-published claims are not visible in `/api/agent/*`.
- **`useSubmitEvidence(claimId)`.** Calling `submit(draft)` uploads the evidence package and then calls `submitEvidence` on the arbitration contract. **Evidence goes to Ethereum (chain 1) even for Gnosis markets.** The live wallet is switched to chain 1 before the prompt, the demo wallet simulates the switch, and `chainId` is returned so the UI can say so. In `mode: 'commit'`, only the package hash is submitted, and the package is kept in `localStorage['pine:evidence-reveal:<hash>']` (commit-reveal is a launch gate).
- **`useRedeem(claimId)`** returns `{ runner, redeemable, positions, blockers }`.

### GitHub and account

- **`useResolveGitHubInput(input)`** handles PR URLs (including `/files` and `/commits/<sha>`), `owner/repo#12`, `owner/repo@sha`, short SHAs and trailing slashes. It returns:
  - `status`: `empty | invalid | loading | resolved | not_found | rate_limited | error`
  - `reason`: a plain-language explanation
  - `source`: a ready-to-use `SourceRef` once a commit resolves. A PR resolves to its head commit and its base commit.
- **`useAccount()`** returns `{ status, account, signIn, signOut, refresh, user, providers }`.
  - `signIn()` with no argument picks GitHub when it is configured and demo otherwise.
  - Account data, meaning linked wallets and preferences, comes from `/api/account/me`. In mock/envio mode it is stored in an HMAC-signed httpOnly cookie, `pine.account`, bound to the GitHub login. This needs no database and survives serverless restarts. In rest mode it is forwarded to the REST API.
- **`useLinkWallet()`** signs a SIWE (EIP-4361) message. The server checks the domain, the nonce (an httpOnly cookie, single use, 10 min), expiry and the signature (EOA first, then ERC-1271/6492). In demo mode, `link()` calls `POST /api/account/wallets/demo` instead. That route is labelled "Demo wallet (simulated signature)" and is disabled outside demo mode.
- **`useUpdatePreferences()`** is a TanStack mutation that updates optimistically. `useAccountData()` exports the account data (as a download) and deletes it.
- **REST mode auth.** The REST API's `bearerAuth` is a short-lived token that the app issues. `GET /api/account/api-token` returns `{ token, expiresAt }`. The token is `pine1.<claims>.<hmac>`, valid for 10 minutes, and carries identity only (`sub` = GitHub login, `gid`, `demo`), never the GitHub token. It is HMAC-SHA256 keyed from `AUTH_SECRET`, and the backend verifies it with `verifyApiToken` from `@pine/server`.
  - In rest mode, `PineProviders` gives the client `DraftStore` a token getter that calls this route.
  - The server account handler mints tokens itself, or sends `PINE_API_TOKEN` when that is set.

### Storage by mode

| | mock | envio | rest |
|---|---|---|---|
| Claims, markets, evidence (reads) | fixtures (in-memory; demo writes persist to `localStorage['pine:mock:*']`) | Envio GraphQL | REST API |
| Manifest/evidence uploads | mock storage (no network; deterministic CID) | `POST /api/ipfs` | `POST /api/ipfs` |
| Drafts | `localStorage` | `localStorage` | REST API (token above) |
| Account (wallets, preferences) | signed cookie `pine.account` | signed cookie | REST API |
| Tx progress | `localStorage['pine:tx:*']` | same | same |

### Testing and QA helpers

- `setDemoTxDelays({ signatureMs: 1, pendingMs: [1, 2], offchainMs: 1, switchMs: 1, resumeAfterMs: 1 })` makes the simulated wallet near-instant. Use it for Playwright screenshots and tests, and call `setDemoTxDelays(undefined)` to restore the realistic delays.
- `useDemoWallet().failNext('create_market')` exercises the failed and resumed states.

### Misc

- `useNow(ms)`
- `useCopy()`
- `useHotkeys({ 'mod+k': open, 'g d': goDashboard, '?': showHelp, j: next })`. Plain keys and sequences are ignored while typing; combos with mod, ctrl or alt still fire.

## 5. Agent routes (for QA)

```bash
curl -s localhost:3004/api/agent/v1/claims?status=open | jq '.items[0].question'
curl -s localhost:3004/api/agent/v1/claims/pine-0009?format=md
curl -si localhost:3004/api/agent/v1/claims/pine-0009/manifest.json | grep -i x-pine-manifest-hash
curl -s localhost:3004/llms.txt
curl -s localhost:3004/.well-known/pine.json
```

The full guide is in [docs/agents/agent-api.md](../agents/agent-api.md).

## Security behavior added after review (2026-10-03)

The package security review added these behaviors. Apps get them automatically; this section explains what users may see.

- **Spending limit is always required.** Pass a defined `spendingLimit` to `useTxRunner` / recovery flows: the claim's funding limit, the draft's, or the account default. An `undefined` limit disables enforcement, so block the action instead. Unparseable or negative cost amounts now block the run (fail closed).
- **No double sends.** Retrying a step whose earlier transaction is still pending re-checks it first and never sends a second one. A double-click on start runs once. A second browser tab cannot run the same plan; it shows the `TX_IN_OTHER_TAB` message and resumes from shared storage.
- **Replaced transactions.** A wallet "speed up" counts as confirmed. A "cancel" counts as failed, and the terms are *not* frozen.
- **Live executor guards.** The executor refuses placeholder or zero addresses and targets without contract code, and confirms the chain switch before sending.
- **Stricter validation.** Bidi-override and zero-width characters are rejected in the question, title and commands. Owner and repo must be valid GitHub names, and source URLs must be `https://github.com/...`. The oracle category and language must match strict patterns, and both are escaped in the Reality template.
- **SIWE.** The expected domain comes from `AUTH_URL`/`NEXTAUTH_URL` when set (set it in production). The message URI must be on the same host, and `issuedAt` is required. State-changing account routes reject cross-site requests (`Sec-Fetch-Site`, `Origin: null`).
- **Demo sign-in** is off in production `rest` mode without GitHub OAuth.
- **Agent API.** Publicly cached responses send `Vary: Accept` (plus the forwarded-host headers when the site URL is derived from the request). Markdown briefs fence creator-supplied prose so it cannot add headings, and always link canonical github.com URLs.
