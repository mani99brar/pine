# Pine Prism: static share build

`@pine/app-prism-share` builds **Pine Prism (apps/prism) as a fully static, browser-only app**. You can publish it as a claude.ai Artifact or host it on any static file host. It runs Prism in demo mode: mock data, the simulated demo wallet and demo sign-in. Everything runs in the visitor's browser.

It is not a reimplementation. The pages, components, styles and data layer are Prism's own source, imported from `../prism/src` through the `@/` alias. This package adds:

- small shims for the Next.js and next-auth entry points;
- an in-browser stand-in for Prism's API routes;
- an in-memory router.

## Build and check

```sh
pnpm --filter @pine/app-prism-share build       # → apps/prism-share/dist (index.html + assets/)
pnpm --filter @pine/app-prism-share verify      # dist checks: ≤255 files, ≤16 MB each, relative URLs, no eval
pnpm --filter @pine/app-prism-share typecheck   # this package plus every Prism/@pine file it reaches
pnpm --filter @pine/app-prism-share lint        # this package's own code (Prism is linted by apps/prism)
```

The entry file is `dist/index.html`. Every URL in the build is relative (`./assets/...`), so you can serve `dist/` from any path on any origin.

Local preview, the way the artifact host serves it:

```sh
node apps/prism-share/scripts/serve.mjs
# http://localhost:4173/host.html: dist/ framed at /a/b/c/ in <iframe sandbox="allow-scripts allow-same-origin">,
# with a CSP close to the artifact's (no 'unsafe-eval'). CSP=loose uses the looser policy.
```

End-to-end checks with Playwright (both run from this package):

```sh
node apps/prism-share/scripts/verify.mjs [--mobile]    # journeys + every request/console error/CSP violation
node apps/prism-share/scripts/compare.mjs [--mobile]   # pixel diff against the live Next app on :3004
```

The `verify` journeys cover:

- the WebGL hero, the scroll story, the light table, PINE-0009, and the composer. In the composer, the run cuts every facet and publishes with the demo wallet. It forces a simulated failure, reloads mid-run, resumes, completes the manual DEX steps and seals.
- evidence submission, demo sign-in, the account page (wallet link, spending limit, export) and the dashboard redeem;
- the policies, agents (including `/llms.txt` and the agent API), risks, activity, drafts and repos pages, and sign-out;
- deep links to every claim state.

The run fails on:

- any request to a host other than the server and Google Fonts;
- any failed request or console error;
- any CSP violation.

`pnpm dev` runs the Vite dev server on port 4174.

## How it works

| Prism / Next.js piece | Static build |
|---|---|
| `next/link` | `src/shims/next-link.tsx`: an anchor with a hash `href` (`#/claims/pine-0009`). Clicks go to the in-memory router. Modifier-clicks keep their native behaviour. |
| `next/navigation` | `src/shims/next-navigation.ts`: `useRouter`, `usePathname`, `useSearchParams`, `useParams`, `notFound` and `redirect`, backed by `src/router`. |
| `next/dynamic` | `src/shims/next-dynamic.tsx`: `React.lazy` + `Suspense`. The hero's three.js scene stays in its own chunk, as it is in Prism. |
| `next/font/google` | `src/shims/next-font-google.ts` + `src/fonts.css`. The same CSS variables and metric-matched fallback faces next/font generates. The font files load from Google Fonts. |
| `next/og`, `next/headers`, `server-only` | `src/shims/empty.ts` (never reached) |
| `next-auth/react` | `src/shims/next-auth-react.tsx`: a local demo session. Demo sign-in signs in as `DEMO_GITHUB_USER`, with the same session shape as `@pine/server/auth`. It persists in localStorage. Sign-out clears it. |
| Root layout, `template.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`, `global-error.tsx` | Prism's own files, used by `src/app/App.tsx` and `src/app/boundaries.tsx`. The layout's `<html>/<body>` wrapper is unwrapped, and its classes go on `<html>`. |
| `src/app/**/page.tsx` (including the async server pages) | `src/app/routes.tsx` imports each page module. Async server components run in the browser with the same `{ params, searchParams }` props, through `use()` and Suspense. `metadata`/`generateMetadata` set the document title. |
| `/api/account/*` | `src/api/account.ts` mirrors the mock-mode cookie backend of `createAccountHandler`: same routes, validation (`preferencesPatchSchema`) and response shapes, stored in localStorage. |
| `/api/github/*`, `/api/ipfs`, `/api/agent/*`, `/llms.txt`, `/llms-full.txt`, `/.well-known/pine.json` | `@pine/server`'s own Fetch handlers run in the page: GitHub in mock mode, IPFS with its deterministic mock CID and keccak hash, and the agent API. `src/api/install.ts` wraps `fetch` before the app mounts. |
| wagmi config | `src/shims/wagmi-config.ts` (swapped in by a Vite plugin) has the same chains, no connectors, and transports that refuse RPC. The demo wallet never needs them. |
| `useAccountData().exportData` | `src/shims/account-data.tsx`. The original downloads by navigating to `/api/account/export`; this version copies the same JSON to the clipboard, falling back to a selectable text box. |
| Demo banner | `src/shims/DemoBanner.tsx` renders Prism's banner plus one line: "Static artifact preview: Pine Prism running entirely in your browser." |

Other details:

- **Environment.** `vite.config.ts` inlines the demo environment:
  - `NEXT_PUBLIC_PINE_DATA_SOURCE=mock`, `NEXT_PUBLIC_PINE_DEMO_WALLET=1`, mock latency on;
  - `NEXT_PUBLIC_SITE_URL=https://pine-prism.example`. This is a reserved documentation domain, so agent briefs and curl snippets show a placeholder.
- **Routing.**
  - The route lives in memory and is mirrored into the URL hash with the History API, so reload, back and forward work.
  - A `#/route` in the initial URL opens that route. So does a plain token: `#claims`, `#compose`, `#agents`, …, or a claim id such as `#pine-0009`.
  - Hashes that are not routes (`#gates`, `#main`) are in-page anchors. `src/app/anchors.ts` scrolls to them without changing the route.
  - Root-relative raw links, such as the endpoint list on the agents page, open in-app. Endpoints render through `src/app/EndpointView.tsx`.
- **Sandboxed forms.** Without `allow-forms`, the browser blocks form submission before `submit` fires. `src/app/forms.ts` cancels the native submission and dispatches `submit` itself, after the same constraint validation. Every Prism form handles submission in JS.
- **CSP.** The build needs no `unsafe-eval`. zod's `new Function` capability probe is turned off (`jitless`) in `src/prelude.ts`. There are no inline scripts.
- **Package variants.** Prism and `@pine/react` link different pnpm variants of the same RainbowKit release. The Vite plugin resolves both from `@pine/react`'s location, giving one copy and one wagmi context.

## Limits

- **Demo only.** There are no real wallets, chains, GitHub OAuth, Sign-In with Ethereum or IPFS pinning. Every transaction is simulated by the demo executor.
- **Data is per browser.** Drafts, demo publications, evidence, trades, the session and the account live in this browser's localStorage, and in memory when storage is blocked. They are not shared between visitors or devices. Clearing site data resets the demo.
- **External links** to GitHub, Seer, Reality.eth, Kleros and block explorers open in a new tab only if the host frame allows popups. The preview never fetches them.
- **No downloads.** The account export copies JSON to the clipboard instead.
- **Agent endpoints** answer inside the page and show `https://pine-prism.example` as the site URL. Outside the preview they are not real HTTP endpoints.
- **No server rendering.** Open Graph images, server metadata other than the title, and the `?qa=1` query switch do not apply. Query strings never reach an artifact. On first load the route template plays its blur-in, which Prism skips for server-rendered HTML.
- **Unused RainbowKit chunks.** RainbowKit's locale and wallet-icon chunks ship (lazy, about 40 small files) but are never loaded in demo mode.

## Maintenance

When you add a page to Prism, add it to `ROUTES` in `src/app/routes.tsx`. If it calls a new API route, handle that route in `src/api/install.ts`.
