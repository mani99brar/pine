# Pine — Security Requirements (research input for architecture decisions)

Status: research draft, 2026-10-02. Author: security research agent. Not legal advice. No project files were modified.
Inputs read: `SPEC.md`, `policies/README.md`, `docs/keeper-bot-market-example.md`, `CLAUDE.md`, `packages/api/src/contracts/{app,errors,redact,migrations}.ts`,
`packages/api/migrations/platform/0001_core.sql`, root configs (`pnpm-workspace.yaml`, `.npmrc`, `package.json`, `contracts/foundry.toml`),
the installed `viem@2.57.0` SIWE sources, and Seer's `MarketFactory.sol` (seer-pm/demo, main).

## How to read this document

- Each requirement has a stable ID, a normative keyword (MUST / MUST NOT / SHOULD), a one-line test idea, and a priority:
  - **P0** — required before any public deployment or mainnet contract deployment (blocks launch).
  - **P1** — required before general availability / first paid customers; may follow a closed pilot.
  - **P2** — hardening; schedule after GA.
- "Verified" marks a fact checked against a primary source during this research (sources at the end). "Spike" marks a behaviour that
  could not be confirmed from documentation and needs a test against the real service before the decision is final.
- Families: `SEC-GH` GitHub, `SEC-AUTH` wallet auth/sessions/CSRF/linking, `SEC-TX` transaction plans, `SEC-CLAIM` claim composition,
  `SEC-EVID` untrusted evidence, `SEC-AGENT` agent-facing surface, `SEC-SC` smart contracts, `SEC-IDX` indexers, `SEC-OPS` platform,
  `SEC-LEGAL` legal/regulatory hooks and launch gates.

## 0. Key findings (read first)

1. **viem's `generateSiweNonce()` is not safe for nonces (verified locally in viem 2.57.0).** It calls `uid(96)`, which fills a buffer
   from `Math.random()` and returns a sliding window: two consecutive nonces share 95 of 96 characters
   (`b.slice(0,95) === a.slice(1)` printed `true`). Anyone who requests one nonce can predict the next ~400. Use `crypto.randomBytes`.
2. **viem's `verifySiweMessage` checks much less than EIP-4361 requires (verified in source).** It checks `domain`, `nonce` and `scheme`
   only when the caller passes a truthy value (an empty-string config silently disables the check), checks the address and the time window,
   and **never checks `uri`, `chainId`, `version` or `issuedAt` freshness**. The suffix regex of `parseSiweMessage` is not anchored.
3. **viem's default `verifyHash` mode (`auto`) asks the RPC first.** It runs the ERC-6492 deployless `eth_call` before local ECDSA
   recovery. A malicious or compromised RPC that returns `true` can therefore authenticate **any** address, EOAs included. Login must
   recover EOAs locally and treat ERC-1271/6492 results as trusting the RPC.
4. **GitHub returns commits from the whole fork network (verified).** Git data from any repository in a network may be accessed from
   any other repository in that network, the upstream included. `GET /repos/{o}/{r}/commits/{sha}` succeeding does **not** prove the
   commit belongs to that repository. A claim about "kleros/x @ SHA" could point at attacker-authored fork code.
5. **Seer's `MarketFactory` interpolates `marketName`/outcomes/category/lang into the Reality.eth question without escaping
   (verified in source + seer-pm/demo PR #504).** A creator can close a JSON string and override the template's outcomes or title.
   Pine's question text must be built from a fixed template with injection-free fields. Seer's `askRealityQuestion` reuses an existing
   question with the same content (nonce 0), so a market twin can be created by copying the text. Only registry-linked markets count.
6. **Bridged tokens on Gnosis are reentrancy hazards (verified).** OmniBridge ERC-677 tokens call `onTokenTransfer` on contract
   recipients. This root cause drove the Agave/Hundred Finance exploit (2022-03-15, about $11M). Any orchestrator or lock that receives
   tokens must be reentrancy-safe and restricted to an immutable collateral allowlist.
7. **GitHub App user tokens are an intersection of user and app access (verified).** "A user access token can only access resources that
   both the user and app can access" and "the app can only access resources in an account where it is installed", but apps "have implicit
   permissions to read public resources when acting on behalf of a user". Listing a user's repositories via `GET /user/repos` therefore
   cannot be relied on without installations. Use public listing endpoints plus explicit repository entry.
8. **Gnosis finality is about 2 epochs (16 slots × 5 s): roughly 160–200 s (verified via Gnosis analytics docs).** Envio HyperIndex rolls
   back on reorg by default (`rollback_on_reorg: true`, `max_reorg_depth` default 200 blocks). It warns that RPC log and header queries
   are not atomic and that external side effects are not rolled back.
9. The frozen `redact.ts` misses `postgres://` and other non-HTTP connection strings, PEM private keys, 40-hex OAuth client secrets,
   base64url session tokens and query strings in Fastify request logs. It also produces false positives on ordinary crypto prose
   ("token approval", "Basic information") and on every public URL with a path. Details are in §11.

---

## 1. GitHub integration (SEC-GH)

### 1.1 Comparison

| Concern | GitHub App, user-to-server token (no installation) | OAuth App, no scopes |
|---|---|---|
| What the grant allows | Permissions fixed in app settings (request **zero** repository/org permissions); implicit read of public resources on behalf of the user (verified). Permissions are not chosen by the URL. | "(no scope): read-only access to public information (including user profile info, repository info, and gists)" (verified). Scope is a URL parameter: a crafted authorize URL can request `repo` for our `client_id`; we must check `X-OAuth-Scopes` and revoke over-scoped tokens. |
| Identify the user | `GET /user` → numeric `id` (immutable) + `login` (mutable). | Same. |
| List user's public repos | `GET /user/repos` limited to installation-accessible repos (intersection, verified). Use `GET /users/{login}/repos` (public), public org memberships, and paste-a-URL entry. **Spike:** confirm `/user/repos` output for an uninstalled app. | `GET /user/repos` lists repos with explicit permission (owner/collaborator/org member, verified description); filter `visibility=public`. Org "OAuth app access restrictions" block private org resources and privileged writes, not public reads (verified). |
| PRs / commits of public repos | Public read via `GET /repos/{o}/{r}/pulls`, `/pulls/{n}`, `/pulls/{n}/commits` (max 250, verified), `/commits/{sha}`, `/compare/{base}...{head}`. | Same endpoints. |
| Viewer permission on a repo | `GET /repos/{o}/{r}` → `permissions{admin,maintain,push,triage,pull}` or GraphQL `viewerPermission`. **Spike:** confirm the field is populated for a public repo in an account without an installation. | Same; **Spike:** confirm with a no-scope token. |
| Token lifetime | Expiring by default: access 8 h, refresh 6 months, refresh is single-use and invalidates the old access token (verified). | Long-lived by default; can opt in to 8 h + refresh tokens (verified). Limit 10 tokens per user/app/scope; 10 new tokens per hour (verified). |
| Revocation signal | `github_app_authorization` webhook: received by default, cannot unsubscribe (verified); otherwise 401 on use. | No webhook; detect via 401. |
| Rate limits | User's personal 5,000 req/h, **shared** with every other app acting for that user (verified). Secondary: 100 concurrent, 900 points/min, 90 s CPU per 60 s (verified). | Same 5,000/h shared limit. |
| PKCE / state | Supported (S256); `state` strongly recommended (verified). | Supported (S256 only; `plain` unsupported); `state` strongly recommended (verified). |

### 1.2 Recommendation

**Use a GitHub App with zero requested permissions and user-to-server tokens with expiration enabled (the default). Do not ask users
to install it.** Reasons: (a) least privilege is enforced by GitHub's app settings rather than by a URL parameter an attacker can alter;
(b) 8-hour access tokens with single-use refresh rotation shrink the value of a stolen database row; (c) a mandatory revocation webhook
exists; (d) GitHub documents GitHub Apps as the preferred integration type. The cost is that repository listing must use public
endpoints plus explicit "owner/repo" or URL entry, which is acceptable because the product is public-repositories-only.
**Fallback (decide after the P0 spike SEC-GH-02):** if a zero-permission app user token cannot read viewer permission on public
repositories in uninstalled accounts, use an OAuth App with no scopes **and** opt in to expiring tokens, plus the scope check SEC-GH-04.
Webhooks: not needed for the product flow (claims pin immutable commits; nothing reacts to pushes). Only `github_app_authorization`
needs a receiving endpoint, with HMAC verification. Do not load the GitHub App private key into the API at all: the user-to-server web
flow needs only `client_id` and `client_secret`.

### 1.3 Requirements

- **SEC-GH-01 (P0) MUST** request zero repository, organization and account permissions in the GitHub App settings. Store the app's
  permission manifest in `packages/shared` and diff it in CI. *Test:* a CI script calls `GET /app` (or reads exported settings) and
  fails on any permission.
- **SEC-GH-02 (P0) MUST** run a recorded spike, before freezing the gateway, against a test account with and without installation.
  It covers `GET /user/repos`, `GET /users/{login}/repos`, `GET /repos/{o}/{r}` `permissions`, GraphQL `viewerPermission`,
  `/pulls/{n}/commits` and `/compare` for both token types. *Test:* fixtures saved as gateway contract tests; the decision is recorded
  in an ADR.
- **SEC-GH-03 (P0) MUST** use the authorization-code flow with PKCE S256 and a ≥128-bit `state` that is single-use, expires within
  10 minutes, and is bound server-side to the current SIWE session id. Abort when the `state`, `redirect_uri` or session does not match.
  *Test:* replaying a callback with another session's state returns 403 and links nothing.
- **SEC-GH-04 (P0, OAuth fallback only) MUST** verify that `X-OAuth-Scopes` is empty on the first call after token exchange. If it is
  not, revoke the token (`DELETE /applications/{client_id}/token`) and fail the link. *Test:* a mocked exchange returning `repo`
  scope leaves no token row and records an audit entry.
- **SEC-GH-05 (P0) MUST** key GitHub identity on the numeric user `id`, never on `login`. Logins are renamed and re-registered.
  Store `login` only as a display snapshot with its fetch time. *Test:* renaming the login in a fixture keeps the same link, and a new
  account reusing the old login does not inherit it.
- **SEC-GH-06 (P0) MUST** store tokens encrypted with AES-256-GCM using a random 96-bit IV per encryption.
  Use AAD = `user_id ‖ provider ‖ token_kind ‖ key_version`, so a ciphertext copied to another row fails to decrypt.
  The key-encryption key comes from a secret manager and is never stored in the database or backups. Store `key_version` per row.
  *Test:* swapping two users' ciphertexts makes decryption fail closed (no token is used, and an audit event is recorded).
- **SEC-GH-07 (P1) MUST** support key rotation. New writes use the newest key, reads accept the configured old versions, and a
  background re-encryption job drops old versions once none remain. *Test:* after rotation and the job, no row references the
  retired version, and old key material removed from config still decrypts nothing.
- **SEC-GH-08 (P0) MUST** decrypt tokens only inside the GitHub gateway and never return, log or persist them in plaintext.
  Modules see only `GitHubGateway`, as the current contract already provides. *Test:* a log-capture test across the whole OAuth flow
  finds no `gh[ousr]_` strings.
- **SEC-GH-09 (P0) MUST** refresh expiring tokens single-flight per user, under a row lock or advisory lock, and persist the new
  refresh token atomically before using the new access token. Refresh tokens are single-use. *Test:* 10 concurrent requests with an
  expired token produce exactly one refresh call and no `bad_refresh_token`.
- **SEC-GH-10 (P1) MUST** handle revocation. On `github_app_authorization` (HMAC-verified with a constant-time compare) or on any 401,
  delete the ciphertext, mark the link `revoked` and audit it. User unlink calls the GitHub token-revocation API, then deletes.
  *Test:* a webhook with a bad signature is rejected; a valid one removes the token row.
- **SEC-GH-11 (P0) MUST** prove commit membership, not mere existence (fork-network objects, finding 4). A commit is accepted for a
  repository only if one of these holds: (a) it equals the head SHA of the selected PR as returned by `GET /pulls/{n}`; (b) it appears
  in that PR's commit list (≤250; otherwise reject or use the compare API); or (c) `GET /compare/{sha}...{default_branch}` returns
  `status` `ahead` or `identical` with `behind_by == 0`. Record the method, ref and time in the claim's provenance. *Test:* a fixture
  commit that exists only in a fork returns 200 from `/commits/{sha}` but is rejected with `UNPROCESSABLE`.
- **SEC-GH-12 (P0) MUST** pin the numeric repository `id` in the claim and resolve it with `GET /repositories/{id}` on every display
  and publication. When `owner/name` now resolves to a different id (rename, transfer or repojacking), flag the claim and refuse new
  publications. *Test:* a fixture where `owner/name` maps to a new id produces `integrity: "repo_identity_changed"`.
- **SEC-GH-13 (P0) MUST** refuse private and internal repositories at every call, rechecked at publish time, and treat a repository
  that later becomes private or is deleted as unavailable without altering the claim. *Test:* a repository flipped to private between
  draft and publish returns `REPO_NOT_PUBLIC`.
- **SEC-GH-14 (P1) MUST** respect rate limits. Honor `retry-after` and `x-ratelimit-reset`, never retry while limited (continuing can
  get the integration banned, verified), cap concurrency per user (≤5) and globally (<100). Use ETag conditional requests and cache
  public metadata. Surface `RATE_LIMITED` with a retry hint. *Test:* a mocked 403 secondary limit with `retry-after: 60` produces no
  further upstream call for 60 s.
- **SEC-GH-15 (P1) MUST** validate every GitHub response with zod: SHAs `^[0-9a-f]{40}$` (reject 64-hex until GitHub supports
  SHA-256 repositories), owner/name charset `[A-Za-z0-9-_.]`, and bounded string lengths. Upstream bodies never reach clients.
  *Test:* a response with an 11 MB title or a malformed SHA produces `UPSTREAM`, and the client message is generic.
- **SEC-GH-16 (P2) SHOULD** record `tree` SHA alongside the commit SHA and optionally a content-addressed source snapshot (git bundle
  or tarball sha256 on IPFS). Force-push, deletion or garbage collection must not make the claimed artifact unretrievable. *Test:* the
  snapshot hash recomputed from `git archive` of the commit matches the claim document.
- **SEC-GH-17 (P1) SHOULD** label claims whose publisher lacked `push` or higher on the repository at publish time as
  "third-party claim", with the permission snapshot and time as a Pine backend attestation, never as a GitHub statement. This deters
  impersonation of maintainers. *Test:* a publisher with only `read` gets `publisherRelation: "third_party"` in the API.

---

## 2. Wallet authentication, sessions, CSRF, account linking (SEC-AUTH)

Verified facts used: EIP-4361 requires the relying party to check the message against expected values (domain, URI, chain ID, nonce,
times, address) and to verify the signature (ERC-191 or ERC-1271). The nonce has at least 8 alphanumeric characters with enough
entropy. "Sessions MUST be bound to the `address`". viem behaviours: findings 1–3.

### 2.1 SIWE

- **SEC-AUTH-01 (P0) MUST** issue the SIWE message server-side. `POST /auth/siwe/challenge {address}` builds the message with
  `createSiweMessage` (domain, uri, chainId, nonce, issuedAt, expirationTime, fixed statement), stores it keyed by nonce, and returns it.
  Verification requires the signed string to be **byte-identical** to the stored message, removing every parser ambiguity (the
  suffix regex is unanchored). *Test:* a signature over the stored message plus an appended line is rejected.
- **SEC-AUTH-02 (P0) MUST NOT** use viem `generateSiweNonce()`. Nonces are ≥128 bits from `crypto.randomBytes`, encoded as alphanumeric
  (hex or base62). *Test:* a unit test asserts the nonce source is `node:crypto`, and 10^5 nonces are distinct with no shared 90-char
  substrings.
- **SEC-AUTH-03 (P0) MUST** make nonces single-use with atomic consumption (`DELETE … WHERE nonce=$1 AND expires_at > now()
  RETURNING`). They expire after ≤10 minutes, are bound to the pre-session cookie and IP-hash that requested them, and are capped at
  ≤5 outstanding per pre-session. *Test:* two parallel verifies with the same signed message yield exactly one session; the second
  call is rejected.
- **SEC-AUTH-04 (P0) MUST** check every field explicitly, not only through viem: `domain` equals the configured host[:port], and the
  config validator rejects an empty value because viem skips falsy checks. `uri` equals the configured origin or starts with origin +
  `/`. `version === "1"`. `chainId` is in the configured set (100; 10200 only in staging). `issuedAt` is within ±5 min of the injected
  clock. `expirationTime` is **required** and ≤ issuedAt + 10 min. `notBefore`, if present, is ≤ now. The address equals the challenge
  address. *Test:* a table-driven negative test per field; each mutated field fails with `UNAUTHENTICATED` and audit `auth.siwe.failed`.
- **SEC-AUTH-05 (P0) MUST** verify EOA signatures locally first (`recoverMessageAddress` over the exact message) and accept on match.
  Use the RPC path (ERC-1271 / ERC-6492) only when `getCode(address)` is non-empty or the signature is 6492-wrapped. Never use viem's
  default `auto` path that trusts `eth_call` first. *Test:* with a mock RPC that answers `true` to every `eth_call`, an invalid EOA
  signature is rejected.
- **SEC-AUTH-06 (P1) MUST** perform ERC-1271 verification against a trusted RPC: a self-hosted node, or two independent providers
  that must agree, on the `finalized` or `latest` block. Accepting undeployed (ERC-6492 counterfactual) accounts is a product
  decision. Default: reject until approved. Admin accounts MUST be EOAs or hardware wallets verified locally. *Test:* disagreeing
  providers fail closed.
- **SEC-AUTH-07 (P1) SHOULD** put a fixed statement in the SIWE message naming the Terms version hash ("…accept Terms v3
  sha256:…"). The stored signed message becomes a cryptographic acceptance record (see SEC-LEGAL-03). *Test:* the session row
  references the terms hash that the signed message contains.
- **SEC-AUTH-08 (P0) MUST** return one generic failure (`UNAUTHENTICATED`, "Sign-in failed") to clients, log the specific reason only
  server-side, and rate-limit challenge and verify per IP and per address. *Test:* 21 challenge requests per minute from one IP
  receive 429.

### 2.2 Sessions

- **SEC-AUTH-09 (P0) MUST** generate the session token from ≥256 bits of CSPRNG output, base64url-encoded with a recognisable prefix
  (`pine_s1_…`) so redaction can match it. Store only `sha256(token)`; look sessions up by hash. *Test:* the DB contains no value equal
  to any issued cookie, and the redactor removes `pine_s1_…`.
- **SEC-AUTH-10 (P0) MUST** set the cookie as `__Host-pine_session` with `Secure; HttpOnly; Path=/; SameSite=Lax`, without `Domain`.
  Lax is needed because the GitHub callback is a cross-site top-level navigation; CSRF is handled by SEC-AUTH-14. *Test:* a response
  header snapshot test, and a request over HTTP to the production app is refused.
- **SEC-AUTH-11 (P0) MUST** issue a new session id at sign-in (and destroy the pre-session), at GitHub link and unlink, and at any
  privilege change. Accept no session id supplied before authentication (fixation). *Test:* a cookie value set before sign-in is never
  valid after sign-in.
- **SEC-AUTH-12 (P1) MUST** enforce idle and absolute expiry server-side. Defaults: users idle 8 h and absolute 72 h; admins idle
  15 min and absolute 4 h. Sessions cannot move funds because every on-chain action needs a wallet signature, which justifies longer
  user sessions; OWASP's 4–8 h absolute guidance applies to admins. *Test:* clock-stepped tests at idle −1 s and +1 s.
- **SEC-AUTH-13 (P0) MUST** support logout and "log out everywhere" by deleting server-side session rows and clearing the cookie. The
  frontend MUST log out when the wallet's selected account changes, because sessions are bound to the address. *Test:* a cookie used
  after logout gets 401.

### 2.3 CSRF for cookie-authenticated JSON APIs

- **SEC-AUTH-14 (P0) MUST** gate every unsafe method (POST/PUT/PATCH/DELETE), including SIWE verify (login CSRF) and logout, with all
  of the following:
  1. Reject `Sec-Fetch-Site: cross-site`. Allow `same-origin`. Allow `same-site` only if explicitly configured.
  2. Otherwise require `Origin`, or else `Referer`, to exactly match an allowlisted origin (no suffix matching). If both are absent,
     reject.
  3. Require a custom header (`X-Pine-Request: 1`), which forces a CORS preflight.
  4. Require `Content-Type: application/json`, except on the multipart evidence route, which still needs points 1–3.

  *Test:* a matrix test of forged form posts, `text/plain` fetches, a missing Origin and an `evil-pine.app` origin; all return
  `CSRF_REJECTED`.
- **SEC-AUTH-15 (P0) MUST** keep GET/HEAD side-effect free. The only exception is the OAuth callback, which is protected by
  SEC-GH-03. *Test:* a route-table lint fails if a GET handler writes to the DB outside the callback allowlist.
- **SEC-AUTH-16 (P0) MUST** serve the API same-origin with the frontend (`/api/v1`). If that is impossible, the CORS allowlist is exact,
  credentials are allowed only for allowlisted origins, and there is no reflection of arbitrary `Origin`. Public agent endpoints use
  `Access-Control-Allow-Origin: *` with **no** cookies read. *Test:* `Origin: https://attacker.example` gets no ACAO header on
  credentialed routes.
- **SEC-AUTH-17 (P0) MUST** serve user content from a **different registrable domain** (e.g. `pine-usercontent.net`), never a
  subdomain of the app domain. Otherwise the content counts as `same-site`, SameSite=Lax cookies flow, and the user-content origin
  becomes a CSRF/XSS springboard. *Test:* a config validator rejects a user-content host that shares the app's eTLD+1.

### 2.4 Account linking (GitHub ↔ wallet) abuse cases

- **SEC-AUTH-18 (P0) MUST** allow GitHub linking only from an authenticated wallet session, with state and PKCE bound to that session.
  This stops linking CSRF, where an attacker's callback URL links the attacker's GitHub to the victim's wallet. *Test:* the callback
  without a matching session links nothing.
- **SEC-AUTH-19 (P0) MUST** enforce a 1:1 link (UNIQUE `github_user_id` and UNIQUE `user_id` in the link table). Re-linking a GitHub id
  to another wallet requires unlinking first, with a cool-down (e.g. 7 days) displayed publicly. Publications snapshot the link that
  existed at publish time. *Test:* linking a GitHub id already linked to wallet A from wallet B returns 409.
- **SEC-AUTH-20 (P1) MUST** show the link (GitHub id, login snapshot and link time) on published claims only if the user opts in.
  Otherwise the off-chain link is private (privacy, SEC-LEGAL-06). It is never written on-chain or to IPFS without explicit consent.
  *Test:* a claim document fixture contains no GitHub login when opt-in is false.
- **SEC-AUTH-21 (P0) MUST** re-evaluate `isAdmin` per request from the current config allowlist, not persist it at session creation.
  Admin-only destructive actions (block content, unblock, change quotas) need a step-up: a fresh SIWE signature less than 5 minutes
  old. *Test:* removing a wallet from config revokes admin on the next request; moderation without step-up returns 403.
- **SEC-AUTH-22 (P1) SHOULD** notify users in-app of new sign-ins, GitHub link changes and admin actions on their records, and keep a
  user-visible security log. *Test:* a link event appears in `GET /api/v1/accounts/security-log`.

---

## 3. Non-custodial transaction plans (SEC-TX)

**Threat:** a compromised API (or database, or dependency, or insider) returns calldata that approves an attacker as spender, sends
collateral to an attacker, creates a market with a different question or deadline than previewed, uses unlimited approvals, or asks for
a signature (permit, Permit2, EIP-7702 authorization, `eth_sign`) that drains funds later. Users sign what the wallet shows, often blind.
The mitigation strategy is to make the API **unable** to produce anything except a narrow, client-verifiable set of calls.

- **SEC-TX-01 (P0) MUST** define a frozen allowlist of `(chainId, to, selector, value policy)` in `@pine/shared`: the orchestrator
  entrypoints, the evidence registry commit/reveal/submit, `collateral.approve`, and LP-lock deposit/withdraw. The plan builder MUST
  refuse anything else, and the **frontend bundle MUST independently enforce the same allowlist** from its own build-time copy, not
  from API responses. *Test:* a property test where any plan with a random `to` or selector is rejected by both the API builder and the
  frontend verifier.
- **SEC-TX-02 (P0) MUST** make calldata deterministic: a pure function of (canonical claim document bytes, user parameters, chain
  constants), implemented once in `@pine/shared`. The frontend recomputes it from the claim document it displayed and compares it
  byte-for-byte before prompting the wallet; on any mismatch it refuses and shows an integrity error. *Test:* tampering one byte of the
  API plan triggers the client refusal.
- **SEC-TX-03 (P0) MUST** use exact approvals only: `approve(spender ∈ allowlist, amount == required)`. Never `type(uint256).max`,
  never `setApprovalForAll` except to an allowlisted LP contract within the same flow, never approvals to EOAs. *Test:* a fork test
  shows allowance is 0 after a completed flow; a unit test shows any plan with `max` approval throws.
- **SEC-TX-04 (P0) MUST NOT** request off-chain signatures that authorize asset movement: no EIP-2612 permits, Permit2, `eth_sign`,
  `personal_sign` of hex digests, EIP-7702 authorizations or `eth_signTypedData` beyond SIWE. *Test:* a lint rule and grep in the API
  and shared packages for these method names fail CI.
- **SEC-TX-05 (P0) MUST** bind plans to chain 100 (10200 only in staging). The frontend checks `eth_chainId` before every send and
  refuses on mismatch. The plan includes `chainId` and the deployment-manifest hash. *Test:* a wallet mocked on chain 1 is refused.
- **SEC-TX-06 (P0) MUST** enforce the user's spending limit on-chain: the orchestrator takes `maxCollateralIn` and reverts if it would
  pull more, refunding any unused amount to the caller in the same transaction. A UI-only limit is insufficient. *Test:* a Foundry test
  where `maxCollateralIn − 1` reverts.
- **SEC-TX-07 (P1) MUST** simulate before signing: the client calls `eth_call` / `simulateContract` through the **user's wallet
  provider**, not the Pine RPC, and shows the decoded balance and allowance deltas. Server-side simulation is advisory only. *Test:*
  an end-to-end test where a reverting plan is blocked before the wallet prompt.
- **SEC-TX-08 (P0) MUST** make plans idempotent and stateful. Each plan has an idempotency key and a persisted state machine (drafted →
  presented → submitted(txHash) → confirmed or failed). `claimId = keccak256(chainid, registry, claimDocHash)` makes a duplicate
  publication revert on-chain. The API never issues a create plan for a claim already registered per the indexer (checked at
  `finalized` and `latest`). *Test:* a crash between plan creation and submission followed by a retry yields the same plan, and two
  submissions produce one registration and one revert.
- **SEC-TX-09 (P0) MUST NOT** hold keys, sign or broadcast. The API has no `WalletClient`, `privateKeyToAccount` or mnemonic config,
  and deploy keys never exist in API environments. *Test:* an ESLint `no-restricted-imports` rule for `viem/accounts` and
  `createWalletClient` in `packages/api`, plus a config schema with no key fields.
- **SEC-TX-10 (P1) MUST** derive human-readable plan summaries on the client from decoded calldata (same ABI as the allowlist). It
  must not display server-supplied free-text descriptions of what a transaction does. *Test:* a server summary that disagrees with the
  decoded calldata is ignored, and the decoded summary is shown.
- **SEC-TX-11 (P1) MUST** require `value == 0` for every allowlisted call unless the entry is explicitly payable with an exact
  expected value. *Test:* a plan with non-zero value on a non-payable entry is rejected.
- **SEC-TX-12 (P1) SHOULD** pin the deployment manifest (addresses, code hashes, chainId) in `@pine/shared`. The frontend verifies
  `eth_getCode` hashes of targets against it before first use in a session. *Test:* a mocked changed code hash blocks plans.
- **SEC-TX-13 (P2) SHOULD** ship the frontend as versioned immutable builds (content hash published, SRI on scripts, strict CSP). A
  compromised API host then cannot alter the verifier. *Test:* a CSP report-only rollout shows zero violations before enforcement.

---

## 4. Claim composition and canonical documents (SEC-CLAIM)

- **SEC-CLAIM-01 (P0) MUST** produce claim documents as RFC 8785 (JCS) bytes from a zod-validated object, with these rules:
  - Amounts and timestamps are strings or integers within the safe range; amounts are never JS floats.
  - Reject duplicate keys with a strict parser, because `JSON.parse` keeps the last one.
  - Reject lone surrogates, `NaN` and `Infinity`.
  - The document carries `schemaVersion`.

  The sha256 and CID are computed over exactly those bytes. *Test:* a golden vector test, and input with duplicate keys or a lone
  surrogate is rejected.
- **SEC-CLAIM-02 (P0) MUST** NFC-normalize all free text before hashing. It MUST reject:
  - bidi controls (U+202A–202E, U+2066–2069) and zero-width characters (U+200B–200D, U+2060, U+FEFF);
  - C0/C1 controls except `\n`;
  - U+241F (the Reality separator).

  This prevents a displayed claim from differing from the hashed claim (Trojan-Source style). *Test:* a fixture list of each
  forbidden code point; each one is rejected with an issue path.
- **SEC-CLAIM-03 (P0) MUST** compose claims only from the reviewed policy catalog. The template is pinned by `{id, version, sha256}`,
  parameters are validated by a per-policy zod schema with length caps, and the policy sha256 is recomputed from catalog bytes at
  publish time. *Test:* a mismatched policy hash or an unknown policy id returns `UNPROCESSABLE`.
- **SEC-CLAIM-04 (P0) MUST** make preview equal publish. The preview response includes the document sha256. Publish takes that sha256
  and re-derives the document; if it differs, publish fails. The pinned bytes are those exact bytes. *Test:* changing a parameter
  between preview and publish without re-preview returns 409.
- **SEC-CLAIM-05 (P0) MUST** keep the on-chain Reality/Seer question text injection-free (finding 5). The question is a fixed template
  plus ASCII-only fields: claim document sha256 (hex), CIDv1 (base32), policy hash (hex) and deadline (ISO-8601 UTC generated from the
  uint64). Free text lives only in the IPFS document. Outcomes are fixed constants (`"Yes"`, `"No"`). Category and lang are constants.
  After building, render the question against the Reality template and assert that the parsed JSON has exactly the expected keys and
  values. *Test:* adversarial strings containing `"`, `\`, `␟`, `}` or newline cannot change the rendered title or outcomes; property
  test.
- **SEC-CLAIM-06 (P0) MUST** keep the SC-001 policy family behind a feature flag (`FEATURE_DISABLED`) until the disclosure process
  required by `policies/README.md` is approved (SEC-LEGAL-09). *Test:* creating an SC-001 draft returns 503 `FEATURE_DISABLED` in all
  environments by default.
- **SEC-CLAIM-07 (P1) MUST** validate timing parameters at composition: deadline ≥ now + minimum window (e.g. 24 h); deadline ≤ now
  + max (e.g. 90 days); reveal window > 0; Reality opening time ≥ reveal deadline; every value ≤ `type(uint32).max` where Seer and
  Reality use uint32. The same checks are enforced on-chain (SEC-SC-07). *Test:* boundary-value tests at each limit ± 1 s.
- **SEC-CLAIM-08 (P1) MUST** label reproduction environments as declarative data: an image digest `sha256:…`, an argv command array and
  pinned versions. Shell strings are never "verified" by Pine. *Test:* a schema rejects image tags without a digest.

---

## 5. Untrusted evidence (SEC-EVID)

- **SEC-EVID-01 (P0) MUST** enforce upload limits at the edge and in `@fastify/multipart` explicitly: `fileSize` (e.g. 25 MiB), `files`
  (≤10), `fields` (≤20), `fieldSize` (≤16 KiB), `parts`, `headerPairs`. Reject `file.truncated`. Use a total request cap, plus the
  per-user `evidence_bytes_per_day` and `evidence_uploads_per_day` quotas consumed atomically before storage. *Test:* a 25 MiB + 1 B
  upload gets 413 and nothing is stored or consumed.
- **SEC-EVID-02 (P0) MUST** stream uploads to temporary storage while hashing, never buffering whole files in memory.
  `ContentStore.put(bytes)` should gain a streaming variant. Abort on limit, and clean up temp files on every path. *Test:* 20
  concurrent 25 MiB uploads keep RSS under the budget.
- **SEC-EVID-03 (P0) MUST** compute sha256 and the CID server-side from the received bytes. Client-supplied hashes are only compared,
  never trusted. Content identity is sha256. *Test:* an upload with a wrong client hash gets 422.
- **SEC-EVID-04 (P0) MUST** resolve the CID-format mismatch: a CIDv1 raw-codec CID is a single block, and Bitswap does not reliably
  move blocks above about 1–2 MiB. Either cap evidence at 1 MiB per object, or pin as UnixFS with pinned chunker parameters, record
  the resulting CID, and keep sha256 as the identity. *Test:* pin a 5 MiB file, fetch it via the gateway by recorded CID, and the
  sha256 matches.
- **SEC-EVID-05 (P0) MUST NOT** extract, decompress, render, transcode, thumbnail, execute or "preview" uploads server-side. That rules
  out ImageMagick, ffmpeg, PDF renderers and unzip, so zip bombs and parser exploits have nothing to hit. Any malware scanning
  (optional) runs in an isolated, resource-limited worker with its own decompression limits. *Test:* a 42.zip-style bomb upload is
  stored as opaque bytes and server CPU and disk stay flat.
- **SEC-EVID-06 (P0) MUST** serve every blob with these headers:
  - `Content-Type: application/octet-stream` (images only from a small allowlist, after magic-byte check, and still as attachment);
  - `Content-Disposition: attachment; filename="<sha256>.bin"`, with the display name only in JSON metadata;
  - `X-Content-Type-Options: nosniff`;
  - `Content-Security-Policy: default-src 'none'; sandbox`;
  - `Cross-Origin-Resource-Policy: cross-origin` only where needed;
  - `Referrer-Policy: no-referrer`;
  - `Cache-Control: public, max-age=31536000, immutable`.

  Polyglots then have no execution context. *Test:* an HTML/JS polyglot download is never rendered inline (header snapshot test).
- **SEC-EVID-07 (P0) MUST** serve blobs only from the separate user-content registrable domain (SEC-AUTH-17). That domain sets and
  reads no cookies, and the API origin never serves user bytes. *Test:* fetching a blob from the app origin gets 404.
- **SEC-EVID-08 (P0) MUST** never use client filenames in storage paths, which are always derived from sha256. Display names are
  NFC-normalized, stripped of control and bidi characters and path separators, and capped at 255 bytes. *Test:* the filename
  `../../etc/passwd‮gpj.exe` is stored by hash and displayed sanitized.
- **SEC-EVID-09 (P0) MUST NOT** fetch user-supplied URLs (no "attach by URL"; no link unfurling or preview). Links are stored as
  inert text and rendered non-clickable, or behind an interstitial with `rel="noopener noreferrer nofollow ugc"`. IPFS reads happen only
  by CID from configured gateways, with redirects disabled and hash verification after download. *Test:* evidence pointing at
  `http://169.254.169.254/` triggers no outbound request (egress mock asserts zero calls).
- **SEC-EVID-10 (P0) MUST NOT** render evidence or claim HTML or Markdown server-side. The v1 client shows plain text (`textContent`).
  Any later Markdown rendering is client-side, sanitized (no raw HTML, no auto-loaded remote images), and runs on the app origin
  only. *Test:* a `<img src=x onerror=…>` payload is displayed literally.
- **SEC-EVID-11 (P0) MUST** add a moderation **block** state distinct from "hide". Blocked bytes are not served (410 or 451) and may be
  unpinned, but the hash, CID, on-chain reference, block reason category and date remain visible as a tombstone. Takedowns never touch
  on-chain data. *Test:* after a block, `GET /content/<sha>` returns 410 and the evidence record still lists sha256 and the on-chain
  transaction.
- **SEC-EVID-12 (P1) MUST** define a takedown procedure for evidence on markets that are still active or disputed. A human decides;
  a sealed copy is preserved for adjudicators when lawful; illegal content such as CSAM is removed and reported, never retained. A
  public transparency log records hash, category and date. *Test:* a runbook dry-run, and the audit entries exist.
- **SEC-EVID-13 (P1) SHOULD** keep evidence confidential before reveal. The client encrypts pre-reveal uploads (AES-GCM with a key
  derived from the commit salt), so Pine staff cannot read or trade on evidence before the reveal. Without this, require uploads only
  in the same client step as the reveal. *Test:* a pre-reveal blob is ciphertext; after reveal, the published key decrypts it to
  bytes matching the committed sha256.
- **SEC-EVID-14 (P1) MUST** show a client-side integrity badge only when the bytes' sha256 equals the on-chain committed or submitted
  hash. *Test:* tampered gateway bytes show "integrity failed".
- **SEC-EVID-15 (P1) MUST** label all evidence, repositories and scripts in the API and UI as untrusted, possibly malicious code, and
  never present them as Pine-verified. *Test:* every evidence object carries `trust: "untrusted"`.

## 6. Agent-facing surface (SEC-AGENT)

- **SEC-AGENT-01 (P0) MUST** separate platform-authored fields from user-supplied fields in machine-readable endpoints (e.g. a
  `userSupplied` object plus a top-level `contentTrust: "untrusted"`). Operator guidance is never mixed into user text, so agents can
  resist prompt injection embedded in claims or evidence. *Test:* a JSON schema snapshot shows that no user text appears outside
  `userSupplied`.
- **SEC-AGENT-02 (P0) MUST** present reproduction steps as declarative, digest-pinned data with a fixed warning: run only in an isolated
  sandbox without secrets, keys or network privileges. Pine never claims they are safe, since a malicious claim publisher could target
  investigating agents. *Test:* every feed item includes the warning code.
- **SEC-AGENT-03 (P1) MUST** exclude hidden or integrity-failed records from feeds and listings while still exposing `moderation`
  and `integrity` status on direct lookup. *Test:* a hidden claim is absent from `/.well-known/…` feeds and present by id with
  `hidden: true`.
- **SEC-AGENT-04 (P1) MUST** keep public agent endpoints unauthenticated and cookie-free (`Access-Control-Allow-Origin: *`),
  versioned, ETag-cacheable and rate-limited per IP, so that they cannot become a credentialed CSRF surface. *Test:* a request
  carrying a session cookie gets identical output, and the cookie is ignored.

---

## 7. Smart contracts (SEC-SC)

- **SEC-SC-01 (P0) MUST** deploy immutable contracts: no proxies, `delegatecall`, `selfdestruct` or `tx.origin`, no owner able to change
  economic or resolution parameters, and **no pause on the evidence registry**. A pause would let the operator censor YES evidence near
  a deadline and manipulate markets. *Test:* a static check (slither, grep) for `delegatecall|selfdestruct|tx.origin|Ownable|pause`
  in `src/`.
- **SEC-SC-02 (P0) MUST** make every external dependency an `immutable` set in the constructor: Seer `MarketFactory`, Reality.eth,
  ConditionalTokens, Wrapped1155Factory, router, LP position manager and the collateral allowlist. Each is checked with
  `code.length > 0`, and `block.chainid` is recorded. The deployment script asserts the addresses against the manifest in
  `@pine/shared`, then sources are verified (Sourcify/Blockscout). *Test:* a fork test where constructor args differing from the
  manifest fail the deploy script.
- **SEC-SC-03 (P0) MUST** make the orchestrator create the Seer market and register the claim atomically. The registry accepts
  registrations **only** from the immutable orchestrator address. The market address is the factory's return value, never a
  precomputed or caller-supplied one. *Test:* a direct `register` call from an EOA reverts, and an orchestrator call creates exactly
  one registry entry and one `NewMarket`.
- **SEC-SC-04 (P0) MUST** derive `claimId = keccak256(abi.encode(block.chainid, address(registry), claimDocSha256))` and reject
  duplicates with a custom error. *Test:* a second publication of the same document reverts `ClaimExists`.
- **SEC-SC-05 (P0) MUST** build the question string on-chain (or verify it on-chain) from the template and hashes per SEC-CLAIM-05.
  Fields reaching Seer contain no `"`, `\`, control characters or U+241F. *Test:* a Foundry fuzz test with arbitrary bytes for the
  free-text parameter (if any exists) reverts or is ignored.
- **SEC-SC-06 (P0) MUST** bind evidence commitments: `commitment = keccak256(abi.encode(EVIDENCE_TYPEHASH, block.chainid,
  address(this), claimId, msg.sender, evidenceSha256, salt))`. Storage is keyed `commits[claimId][msg.sender][commitment] = uint64
  timestamp`. Keying by sender means a copied commitment cannot block or front-run the original and can never be revealed by the
  copier. *Test:* an attacker front-running with the same hash leaves the victim's commit succeeding; the attacker's reveal reverts.
- **SEC-SC-07 (P0) MUST** use explicit timing:
  - commit and direct submission are valid iff `block.timestamp < deadline`;
  - reveal is valid iff `block.timestamp < revealDeadline` for a commit made before `deadline`;
  - `revealDeadline ≤ Reality openingTime`;
  - all timestamps are `uint64` in Pine contracts, `SafeCast` to `uint32` for Seer and Reality;
  - creation requires `deadline ≥ block.timestamp + MIN_WINDOW` and `≤ block.timestamp + MAX_WINDOW`.

  *Test:* boundary tests at `deadline−1`, `deadline` and `deadline+1` with `vm.warp`. Note that Gnosis block timestamps advance in
  5 s slots, so tests must not assume the exact second is reachable.
- **SEC-SC-08 (P0) MUST** require a ≥128-bit, client-generated random salt, one per commitment. The salt is never sent to or derivable
  by the backend before reveal; low-entropy evidence would otherwise be brute-forceable from the commitment. *Test:* a client unit
  test checks the salt source and length, and API schemas have no salt field before reveal.
- **SEC-SC-09 (P0) MUST** make reveal idempotent-safe: reveal once per commitment, emitting `EvidenceRevealed(claimId, submitter,
  commitment, evidenceSha256, cid, committedAt)`. A reveal for an unknown or expired commitment reverts. *Test:* a double reveal
  reverts, and a reveal after `revealDeadline` reverts.
- **SEC-SC-10 (P1) MUST** document reveal front-running: once a reveal is in the public mempool, its content is public and traders can
  act before inclusion. Priority and attribution are by commit time, so copying a reveal gains nothing. Optional mitigation: evaluate
  Shutter's encrypted mempool on Gnosis for reveal transactions. *Test:* the docs exist, and a front-run direct submission after the
  deadline reverts.
- **SEC-SC-11 (P0) MUST NOT** iterate user-growable storage. Use per-claim counters and events instead of arrays, and give no view
  function unbounded loops. *Test:* a gas snapshot of commit/reveal is constant after 10,000 prior submissions.
- **SEC-SC-12 (P0) MUST** put `nonReentrant` on every external state-changing function that makes external calls, follow
  checks-effects-interactions, and treat every token transfer as a callback. ERC-677 bridged tokens call `onTokenTransfer` (the
  Agave/Hundred precedent). Collateral is an immutable allowlist of tokens without transfer hooks, to be confirmed for sDAI/WXDAI on a
  fork. *Test:* a malicious ERC-677 mock attempting reentry into the orchestrator reverts.
- **SEC-SC-13 (P0) MUST** have `onERC1155Received`/`onERC1155BatchReceived` (CTF positions) and `onERC721Received` (LP NFT) accept only
  when `msg.sender` is the expected immutable contract and an internal operation is in progress. Unsolicited transfers revert.
  *Test:* sending an arbitrary ERC-1155 to the orchestrator reverts.
- **SEC-SC-14 (P0) MUST** leave zero token balances (collateral, ERC-1155, ERC-20 outcome tokens, LP NFTs) in the orchestrator after
  every transaction, refunding remainders to `msg.sender` in-transaction. There are no rescue or sweep functions, since those amount to
  custody. *Test:* an invariant test asserts orchestrator balances are zero after every handler call.
- **SEC-SC-15 (P1) MUST**, if the LP-NFT lock is built, meet these rules:
  - it is immutable and has no admin;
  - the owner is the `from` of `safeTransferFrom` (not `operator`), and the sender is the immutable position manager;
  - the unlock time is fixed at deposit and is ≥ the claim's reveal deadline plus the adjudication horizon;
  - nobody can extend the lock or redirect withdrawal;
  - withdrawal goes to the owner via `transferFrom` (avoiding receiver-hook lockout);
  - the fee-collection policy is explicit;
  - `Locked` and `Unlocked` events are emitted.

  *Test:* a third party cannot withdraw or extend, and the owner can withdraw at `unlock` but not at `unlock−1`.
- **SEC-SC-16 (P0) MUST** emit complete events for every state change an indexer needs, with no view calls required:
  - `ClaimRegistered(claimId idx, market idx, creator idx, questionId, conditionId, claimDocSha256, cid, policySha256, repoId,
    commitSha, deadline, revealDeadline, openingTime)`;
  - `EvidenceCommitted(claimId idx, submitter idx, commitment, uint64 at)`;
  - `EvidenceRevealed(…)`;
  - `EvidenceSubmitted(claimId idx, submitter idx, evidenceSha256, cid, uint64 at)`;
  - `Locked` / `Unlocked`.

  *Test:* the indexer conformance suite rebuilds full state from logs alone.
- **SEC-SC-17 (P0) MUST** pass these before mainnet: `forge test` with fuzz and invariant suites; fork tests against the real Seer,
  Reality and CTF on Gnosis (read-only); slither/aderyn clean or triaged; at least one independent external audit; a public
  bug-bounty scope. *Test:* CI gates and an audit report linked in the ADR.
- **SEC-SC-18 (P1) MUST** require a `minBond` floor on Reality questions to deter cheap wrong answers. It is fixed per policy in the
  claim document and checked on-chain. *Test:* creation below the floor reverts.
- **SEC-SC-19 (P1) MUST** use a hardware-wallet deployer that holds no privileges after deployment. The deployment is reproducible:
  pinned solc 0.8.37, `bytecode_hash=ipfs`, recorded constructor args. *Test:* the CI build reproduces deployed runtime bytecode
  (metadata-aware compare).

## 8. Indexer integrity (SEC-IDX)

- **SEC-IDX-01 (P0) MUST** track `latest`, `safe` and `finalized` heads. Each record carries `finality: pending|safe|finalized`.
  Security-relevant facts are asserted only at `finalized`: "committed before deadline", funding reconciliation and
  claim→market integrity. *Test:* a record above the finalized head is served with `finality: "pending"`.
- **SEC-IDX-02 (P0) MUST** handle reorgs in the native poller. Store `(number, hash, parentHash)` for indexed blocks. On a parent
  mismatch, roll back to the common ancestor in one transaction, deleting rows with `block_number > fork point`. Never roll back below
  `finalized`; a conflict there halts the indexer and alerts. *Test:* a simulated 3-block reorg yields a read model equal to a clean
  re-index, and a fake reorg below finalized halts.
- **SEC-IDX-03 (P0) MUST** configure Envio explicitly: `rollback_on_reorg: true` and `max_reorg_depth` ≥ finality depth with margin
  (default 200 blocks ≈ 1,000 s on Gnosis). Prefer HyperSync or verify the log `blockHash` against headers, given the documented
  non-atomic RPC caveat. Handlers make no external side effects (not rolled back). *Test:* the conformance reorg scenario passes on
  both indexers.
- **SEC-IDX-04 (P0) MUST** make writes idempotent: unique `(chain_id, block_hash, log_index)` with upserts, the cursor advanced in the
  same DB transaction as data, and logs with `removed: true` deleted. *Test:* replaying the same range twice leaves an identical
  read-model hash.
- **SEC-IDX-05 (P0) MUST** filter logs by the exact immutable contract addresses from the manifest and the expected `topic0`, decode
  them with strict ABIs, and validate them with zod. *Test:* an identical event from a look-alike contract is ignored.
- **SEC-IDX-06 (P0) MUST** verify `eth_chainId` against config at startup (fail closed) and use ≥2 independent RPC providers.
  Cross-check the finalized block hash periodically; on disagreement, alert and freeze `finalized` advancement. *Test:* mocked
  providers disagreeing at the same height stop finality advancement.
- **SEC-IDX-07 (P0) MUST** expose staleness on every read-model response: `{indexedBlock, indexedBlockTime, finalizedBlock, headBlock,
  lagSeconds, status: ok|lagging|stalled}`. `lagging` applies when head age exceeds 60 s (12 slots) or indexer lag exceeds a
  threshold. Plan endpoints that depend on chain state return `NOT_READY` when status is not `ok`. *Test:* a frozen fake head older
  than 60 s makes plan creation return 503 with status `lagging`.
- **SEC-IDX-08 (P0) MUST** cross-verify each `ClaimRegistered` against Seer's `NewMarket` in the same transaction (market, questionId,
  conditionId) and recompute the expected question text from the pinned claim document. Mismatches set `integrity: "failed"` and the
  claim is hidden from feeds. *Test:* a fixture with a question text differing by one byte is flagged.
- **SEC-IDX-09 (P1) MUST** run one shared conformance suite (events → read model, including reorgs, duplicates and staleness) against
  both indexers and the read-model fakes. *Test:* the same suite runs in each package's CI.
- **SEC-IDX-10 (P1) MUST** use block timestamps (not ingestion time) for all displayed submission times. *Test:* a fixture with a
  delayed ingestion still displays the block time.
- **SEC-IDX-11 (P1) MUST** use a dedicated indexer DB role with write access only to its schema. The API has SELECT only. *Test:* an
  API-role insert into an indexer table fails.
- **SEC-IDX-12 (P2) SHOULD** produce a deterministic read-model digest per finalized block and compare it across the two
  implementations in staging. *Test:* a nightly job reports equal digests.

## 9. Platform and operations (SEC-OPS)

- **SEC-OPS-01 (P0) MUST** validate configuration with zod at startup and fail closed. Production requires:
  - https origins;
  - a non-empty SIWE domain;
  - chainId 100;
  - a user-content domain with a different eTLD+1;
  - AES key length 32 B;
  - no default values for secrets;
  - an explicit `trustProxy`.

  *Test:* each invalid config makes the process exit non-zero with a redacted reason.
- **SEC-OPS-02 (P0) MUST** load secrets from a secret manager or the runtime environment only, never from repo files. Secret values are
  wrapped in a `Secret` type whose `toString`, `toJSON` and `util.inspect` return `[REDACTED]`, and all secrets are automatically
  registered with `createRedactor`. *Test:* `JSON.stringify(config)` contains no secret value.
- **SEC-OPS-03 (P0) MUST** configure logs so that:
  - pino `redact` covers `req.headers.authorization|cookie|x-api-key` and `res.headers["set-cookie"]`;
  - the request serializer strips query strings (OAuth `code`/`state`) or logs only the route pattern;
  - no request or response bodies are logged;
  - errors go through `safeErrorMessage`.

  *Test:* a log-capture test over the OAuth callback and SIWE verify finds no code, cookie or token.
- **SEC-OPS-04 (P0) MUST** rate-limit globally and per route: the auth challenge and verify, GitHub proxy routes, uploads and agent
  feeds. Limits are keyed by user id when authenticated and by client IP otherwise. `trustProxy` is set to the exact proxy hop count or
  CIDRs; otherwise one load-balancer IP shares one bucket, or `X-Forwarded-For` spoofing bypasses limits. A shared store is used
  across instances. *Test:* a spoofed `X-Forwarded-For` from a non-proxy peer does not change the bucket.
- **SEC-OPS-05 (P1) MUST** add quotas beyond the per-user ones: per-IP for anonymous endpoints (nonces, feeds), global daily caps for
  pinning bytes and GitHub calls, and per-user `plans_per_day`. *Test:* a global pin cap returns `QUOTA_EXCEEDED` for everyone.
- **SEC-OPS-06 (P0) MUST** limit moderation to hide or block (SEC-EVID-11), always with a reason code. It never edits claim text,
  evidence bytes or on-chain references, and its state is exposed in APIs. *Test:* no moderation code path issues UPDATE on claim
  documents (repository test, plus a DB trigger that rejects updates).
- **SEC-OPS-07 (P0) MUST** keep an append-only audit log: the API role has INSERT only (no UPDATE or DELETE). It covers sign-in
  success and failure, link and unlink, publications, plan creation and state changes, uploads, moderation and admin actions. It holds
  redacted `details` (recursive redaction inside `AuditLog`, not left to callers) and an IP retention limit (e.g. 30 days, then
  truncate to /24 or /48). *Test:* an UPDATE on `audit_log` as the API role fails with a permission error.
- **SEC-OPS-08 (P0) MUST** send these security headers on the API (helmet):
  - HSTS (1 y, includeSubDomains);
  - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` for JSON;
  - `nosniff`;
  - `Referrer-Policy: no-referrer`;
  - `Cross-Origin-Opener-Policy: same-origin`;
  - no `X-Powered-By`.

  *Test:* a header snapshot test.
- **SEC-OPS-09 (P1) MUST** set request hardening explicitly: Fastify `bodyLimit` (64 KiB JSON), `connectionTimeout`,
  `requestTimeout`, `maxParamLength`, prototype-poisoning protection set to `error`, and `requestIdHeader` false or validated (no
  client-controlled ids in logs). *Test:* a `__proto__` payload gets 400.
- **SEC-OPS-10 (P0) MUST** use least-privilege DB roles: `pine_migrator` (DDL, used only by the migrate step), `pine_api` (DML on app
  tables, INSERT-only audit, SELECT on indexer schema), `pine_indexer`, and `pine_readonly`. There is no superuser at runtime, TLS uses
  `verify-full`, and `statement_timeout`/`lock_timeout` are set. *Test:* the API role cannot `CREATE TABLE`.
- **SEC-OPS-11 (P1) MUST** encrypt backups, enable PITR and restore-test quarterly. The token KEK is stored separately from backups.
  *Test:* a restore drill record exists, and restored ciphertexts are unreadable without the KEK.
- **SEC-OPS-12 (P0) MUST** harden the supply chain:
  - `pnpm install --frozen-lockfile` in CI and deploys;
  - `minimumReleaseAge` ≥ 10080 (7 days) for production, versus the current 4320;
  - `trustPolicy: no-downgrade`;
  - explicit `strictDepBuilds: true` and `blockExoticSubdeps: true`;
  - `allowBuilds` limited to reviewed packages;
  - `packageManager` pinned with integrity (already present);
  - OSV/`pnpm audit --prod` gating;
  - SBOM;
  - container images pinned by digest;
  - Foundry and vendored Solidity libraries pinned by commit with checksums.

  *Test:* CI fails on a lockfile drift or an unapproved build script.
- **SEC-OPS-13 (P1) SHOULD** compile TypeScript ahead of time and run `node dist/server.js` in production. Remove `tsx` (an esbuild
  native binary and loader hook) from runtime dependencies. Run as non-root with a read-only filesystem. *Test:* the production image
  has no `tsx`/`esbuild` in `node_modules`.
- **SEC-OPS-14 (P0) MUST** enforce an egress allowlist: GitHub API, configured RPC providers, IPFS pinning and gateways, and the
  secret manager. This also contains SSRF and exfiltration. *Test:* an outbound request to an unlisted host fails in staging.
- **SEC-OPS-15 (P1) MUST** pin to ≥2 independent IPFS providers (or one plus a self-hosted node), re-verify pins periodically
  (fetch and hash), and use pin-only scoped tokens. *Test:* a nightly job reports every published claim document as retrievable with
  a matching hash.
- **SEC-OPS-16 (P1) MUST** alert on: sign-in failure spikes, admin sign-ins, moderation actions, indexer lag or RPC disagreement,
  quota exhaustion, GitHub 401 bursts and migration failures. *Test:* synthetic events fire alerts in staging.
- **SEC-OPS-17 (P1) MUST** run jobs under transaction-scoped advisory locks (`pg_try_advisory_xact_lock`) or a dedicated connection.
  A pooled session lock must never leak; jobs are idempotent and never sign. *Test:* killing a job mid-run leaves no lock held.
- **SEC-OPS-18 (P1) MUST** add secret scanning (gitleaks/trufflehog) in CI and pre-commit, and mask `GNOSIS_RPC_URL` in CI logs
  (`forge` prints RPC URLs on fork errors). *Test:* a planted test token fails CI.

## 10. Legal and regulatory flags (SEC-LEGAL) — not legal advice

Prediction markets and event contracts are regulated or prohibited in many jurisdictions: CFTC event-contract rules in the US,
gambling regulators in the UK and France, and others. Sanctions law applies to wallet counterparties. Data-protection law (GDPR) applies
to wallet↔GitHub links and IP logs. Pine does not run the market protocol (Seer, Reality.eth and Kleros do), but it composes, promotes
and helps fund markets. Whether that makes Pine an operator or facility, or a promoter of gambling, is a human/legal decision.

- **SEC-LEGAL-01 (P0) MUST** provide a geofencing hook: a platform preHandler with a country resolver from a trusted CDN header and a
  config policy per action class (browse, publish, fund-plan, links to trading). It returns `451` and audits. In production it fails
  closed for gated actions when the country is unknown. The policy content is a human decision. *Test:* a blocked country returns 451,
  and a missing header in production returns 451 for `fund-plan`.
- **SEC-LEGAL-02 (P0) MUST** provide a sanctions-screening hook on wallet addresses before publish and fund plans (provider or
  OFAC-list adapter; fail closed when the screen is unavailable). Results are cached with a TTL. *Test:* a listed address fixture is
  refused, and a provider timeout refuses.
- **SEC-LEGAL-03 (P0) MUST** keep versioned ToS and risk-disclosure documents identified by sha256. The acceptance record stores user
  id, wallet, version hash, UTC time, method (SIWE statement or signature) and country. A version change requires re-acceptance. Each
  funding plan records a risk acknowledgement of the exact displayed amounts, fees and maximum loss. *Test:* a plan without a current
  acceptance returns 403 `TERMS_REQUIRED`.
- **SEC-LEGAL-04 (P0) MUST NOT** custody anything: no hot wallets, no omnibus or treasury contracts holding user funds, and no fee
  skimming in contracts unless humans approve a fee model (SEC-LEGAL-10). *Test:* an architecture review checklist, plus SEC-TX-09 and
  SEC-SC-14 tests.
- **SEC-LEGAL-05 (P0) MUST** use approved outcome wording in APIs, as copy keys ("No qualifying counterexample submitted"). Never
  "safe", "certified" or "secure"; never present prices as the probability of a bug-free system; never promise refunds on invalid
  outcomes. *Test:* a lint over API copy files for banned words.
- **SEC-LEGAL-06 (P1) MUST** minimize personal data on immutable media: no GitHub identity, IP or email in IPFS or on-chain without
  opt-in. Off-chain PII is deletable on request. A DPIA and privacy notice exist. *Test:* a schema check that claim documents have no
  PII fields unless opt-in.
- **SEC-LEGAL-07 (P0) MUST** adopt a staff conflict-of-interest and trading policy. Staff with access to moderation queues, pre-reveal
  evidence or admin data must not trade Pine-linked markets. Access to such data is logged (SEC-OPS-07). *Test:* a policy document is
  signed; an access-log review is in the runbook.
- **SEC-LEGAL-08 (P1) MUST** account and disclose sponsorship-program funding separately from customer funding (SPEC §1). Operator
  funding makes Pine a market participant, which needs legal review. *Test:* sponsorship flags appear on plans and claims.
- **SEC-LEGAL-09 (P0) MUST** have an approved live-vulnerability disclosure process before enabling SC-001 (and any claim against
  deployed systems), plus a law-enforcement and takedown request process. *Test:* a feature flag stays off until an ADR signed by an
  owner exists.
- **SEC-LEGAL-10 (P0) MUST** hold launch gates escalated to humans; engineering cannot decide these:
  1. Served and blocked jurisdictions, and whether Pine's role requires registration or licensing (event contracts or gambling).
  2. Sanctions and KYC/AML posture and the screening provider.
  3. ToS, privacy notice and risk-disclosure copy.
  4. The fee and revenue model (custody and regulated-activity implications).
  5. Sponsorship-program structure.
  6. Insider and self-dealing rules. Customers and maintainers hold non-public knowledge about their own code and may trade their own
     markets.
  7. SC-001 enablement and the disclosure policy.
  8. Evidence takedown, legal hold and transparency policy.
  9. Data retention and GDPR basis.
  10. Accepting smart-contract wallets (ERC-1271/6492) for login.
  11. Linking to or embedding trading UI versus showing references only.
  12. External contract audit sign-off and admin-key custody and incident response.

  *Test:* each gate is a tracked item with an owner and decision record, and the release checklist blocks on open gates.

---

## 11. Critique of the drafted contracts (with concrete fixes)

The frozen contracts are a good base. These are already right: no wallet client in the API, sessions never carry the token,
`ApiError` with a generic `INTERNAL`, idempotent content store, append-only checksummed migrations, bounded metric labels, moderation
that never alters immutable records. The issues below are ordered by severity. Because the files are frozen, each fix should go through
the question/ADR process in `CLAUDE.md`.

### 11.1 `app.ts`

| # | Issue | Fix | Sev |
|---|---|---|---|
| A1 | `import type { AppConfig } from "./config.js"` and the referenced `src/contracts/testing.ts` do not exist. Each lane will invent config, and fail-closed validation and secret marking will be inconsistent. | Freeze `config.ts`: a zod schema plus `type AppConfig = z.infer<…>`, a `Secret` wrapper type, and the production refinements of SEC-OPS-01. Freeze `testing.ts` fakes. | P0 |
| A2 | `GitHubGateway.getCommit` says "Null when the object does not exist in that repository", but GitHub serves fork-network objects through any repository in the network, so existence ≠ membership. | Add `verifyCommitMembership(userId, owner, name, sha, ref: {pull:number}\|{branch:string}) → {method, verifiedAt}` (SEC-GH-11). Document that `getCommit` proves nothing about membership. | P0 |
| A3 | `SessionInfo.githubLogin` only; logins are mutable and reclaimable. | Add `githubUserId: number \| null`; keep login as a display snapshot. Add `authenticatedAt`, `idleExpiresAt`, `absoluteExpiresAt`. | P0 |
| A4 | `isAdmin` semantics are unclear (is it computed at session creation?), and there is no step-up. | State "re-evaluated per request from config". Add `requireStepUp(maxAgeSeconds)` preHandler (SEC-AUTH-21). | P0 |
| A5 | `ContentStore.put({bytes})` buffers whole uploads, and `mediaType` is caller-supplied with unclear identity semantics (same bytes with a different type?). It cannot block content. | Add `putStream(stream, {maxBytes})`. Exclude `mediaType` from identity and record a server-sniffed type. Add `block(sha256, reasonCode)` / `isBlocked`. Serving uses SEC-EVID-06 headers only. | P0 |
| A6 | `StoredContent.cid` is "CIDv1 raw codec": a single block, which is not retrievable via Bitswap above about 1–2 MiB. | Either cap at 1 MiB or specify the UnixFS layout and chunker in the contract (SEC-EVID-04). | P0 |
| A7 | `ModerationGateway` has only "hidden" (still retrievable by id). It cannot express a legal takedown or malware block. | `ModerationAction = "hide" \| "block_content"`; blocked bytes return 410/451 while metadata and on-chain refs stay visible. | P0 |
| A8 | No compliance hooks in `AppContext` (geofence, sanctions, terms), so modules can forget them. | Add `compliance: { assertAllowed(req, action) ; requireCurrentTerms(userId) }`, enforced by the platform per route tag. | P0 |
| A9 | No frozen transaction-plan type or allowlist, though this is the most safety-critical cross-lane contract. | Freeze `TxPlan`, `TxAllowlistEntry` and the deterministic encoder in `@pine/shared` (SEC-TX-01/02). | P0 |
| A10 | `ChainGateway` exposes one `publicClient`, with no finality, quorum or chain-id assertion. SIWE ERC-1271 and plan pre-checks therefore trust a single RPC. | Add `finalizedBlock()`, `secondaryClient` or a `crossCheck()`, and assert startup `eth_chainId` (SEC-IDX-06). Document that SIWE EOAs are verified locally. | P1 |
| A11 | The RouteModule contract has no per-route security class, so CORS, CSRF, auth and geofence could be applied inconsistently. | Route `config: { access: "public" \| "session" \| "admin", csrf: boolean, geo: ActionClass \| null }` enforced by the platform; public routes never read cookies (SEC-AGENT-04). | P1 |
| A12 | `AuditEntry.details: Record<string, unknown>` relies on callers to redact; `ip` is stored without a retention rule. | Make `AuditLog.record` redact recursively itself and cap size. Document IP retention (SEC-OPS-07). | P1 |
| A13 | `QuotaName` lacks anonymous/IP, global and plan quotas. | Add `siwe_challenges_per_ip`, `plans_per_day`, `github_calls_per_user_hour`, `pin_bytes_global_day` (SEC-OPS-05). | P1 |
| A14 | `GitHubGateway` has no repo-by-id lookup (renames, repojacking) and no PR-commits or compare. | Add `getRepoById(userId, id)` and `listPullCommits(...)` (SEC-GH-11/12). | P1 |
| A15 | `JobDefinition` says "Postgres advisory lock" without scope. Session locks on pooled connections leak or are released early. | Specify `pg_try_advisory_xact_lock` inside a transaction or a dedicated connection (SEC-OPS-17). | P2 |
| A16 | `GitHubCommit.sha` allows 64-hex SHA-256 object ids. GitHub has no SHA-256 repositories, and this widens accepted input. | Accept 40-hex only until needed (SEC-GH-15). | P2 |

### 11.2 `errors.ts`

| # | Issue | Fix | Sev |
|---|---|---|---|
| E1 | Validation `issues[].message` is reflected from AJV/zod unredacted. It may echo input (e.g. a user pasting a token into a field). | Pass messages through the redactor (give `toErrorResponse` a `redact` parameter) or map to generic messages by keyword. Keep the 200-char cap. | P1 |
| E2 | `ApiError.message` is developer-authored and returned verbatim, so one interpolated secret leaks. | Also redact `ApiError.message` in `toErrorResponse` (defense in depth). | P1 |
| E3 | Any thrown object with a `validation` array is treated as a validation error, so third-party errors can be reflected. | Check `error.code === "FST_ERR_VALIDATION"` (Fastify) or an explicit brand. | P2 |
| E4 | 429 and 503 responses carry no `Retry-After`. | Add an optional `retryAfterSeconds` to `ApiError`; the platform sets the `Retry-After` header. | P2 |
| E5 | No codes for legal gating or terms. | Add `UNAVAILABLE_FOR_LEGAL_REASONS: 451`, `TERMS_REQUIRED: 403`, `STEP_UP_REQUIRED: 401`, `INTEGRITY_FAILED: 409/422`. | P0 (needed by SEC-LEGAL-01/03, SEC-AUTH-21) |
| E6 | Plugin-thrown 401/403/404 collapse to `BAD_REQUEST` 400. This is safe but hides auth failures from clients. | Map 401→UNAUTHENTICATED, 403→FORBIDDEN, 404→NOT_FOUND with generic messages. | P2 |
| E7 | `requestId` must be server-generated. | Document "never from a client header" (Fastify v5 `requestIdHeader: false`). | P2 |

### 11.3 `redact.ts` — gaps and false positives

Gaps (secrets that leak today):

| # | Gap | Example | Fix | Sev |
|---|---|---|---|---|
| R1 | Only `http(s)` and `ws(s)` URLs are matched. Database and cache connection strings with passwords pass through. | `postgres://pine:S3cret@db:5432/pine` is untouched. | Generic scheme pattern `\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+` with userinfo, path and query scrub; plus scheme-less `user:pass@host`. | P0 |
| R2 | PEM private keys (GitHub App key, TLS keys) are not matched. | `-----BEGIN RSA PRIVATE KEY-----…` | `/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g` | P0 |
| R3 | Opaque random tokens are not pattern-matchable unless known. Session tokens are created at runtime, so they are never "known". | base64url session id, 40-hex OAuth `client_secret`, UUID-format provider keys | Prefix all Pine-issued tokens (`pine_s1_`, `pine_csrf_`) and add patterns. Auto-register every config secret (A1). Add a 40-hex pattern when labelled. | P0 |
| R4 | Fastify's default request logging writes `req.url` including the query string, and the redactor is not wired into pino. | `/auth/github/callback?code=…&state=…` in logs | pino `redact` paths, a URL serializer without the query (SEC-OPS-03), and a `hooks.logMethod` that runs `redact` on string args. | P0 |
| R5 | API keys embedded in the hostname are kept, since the scrub keeps the host. | `https://<endpoint-name>.xdai.quiknode.pro/<token>/` (endpoint name semi-secret) | Allow a config flag to redact the host for configured RPC hosts; register full RPC URLs as known secrets (they are known from config). | P1 |
| R6 | `\b` before `gh[pousr]_` fails after `_` (both are word characters). | `x_ghp_ABC…` (rare) | Use `(?<![A-Za-z0-9])` instead of `\b`. | P2 |
| R7 | `token=<value>` (without whitespace) is not a label. | `token=abc123def456` | Add `token\|auth\|authorization\|credential\|apikey\|dkey` to the label pattern, with `=` or `:` required. | P1 |
| R8 | Label values stop at the first space, so passphrases with spaces leak their tail. | `"password":"correct horse battery"` | For quoted values, consume to the matching closing quote. | P2 |
| R9 | 0x-prefixed private keys are explicitly not matched. That is deliberate (hashes are public), but env dumps leak keys. | `PRIVATE_KEY=0x…` is caught only via the label | Keep the label pattern; enforce "no keys in API config" (SEC-TX-09). | P2 |
| R10 | No input cap before running regexes: multi-MB upstream bodies are scanned fully. | 20 MB error body | Truncate input to 64 KiB **before** redaction (then cap output as now). | P2 |

False positives (good text destroyed):

| # | Issue | Example | Fix |
|---|---|---|---|
| F1 | `token\s+[A-Za-z0-9…]{8,}` (case-insensitive) matches crypto prose. | "insufficient token approval" → "insufficient [REDACTED]"; "Basic information" → "[REDACTED]" | Match only in a header context: `(?:Authorization\s*[:=]\s*)?(?:Bearer\|Basic)\s+…`, and drop `token` unless preceded by `Authorization:`. |
| F2 | Every URL with a path is reduced to the host, including public GitHub, explorer and IPFS links. | `https://github.com/o/r/pull/1` → `https://github.com/[REDACTED]` | Keep paths for an allowlist of public hosts (github.com, gnosisscan.io, configured gateways) **only when there is no query and no userinfo**. |
| F3 | The header comment says to redact "every string that is logged, persisted, **returned** or notified". Applied to domain data (claim text, `htmlUrl`, evidence names), it corrupts records. CLAUDE.md says "error string". | — | Clarify: the redactor applies to error, log, audit and notification strings only, never to domain data. |
| F4 | Unprefixed 64-hex runs (sha256 digests printed without 0x, e.g. `sha256:abc…`) are redacted. | Lockfile and integrity logs | Acceptable (safer). Optionally exempt the `sha256:` prefix. |

### 11.4 `migrations.ts`

| # | Issue | Fix | Sev |
|---|---|---|---|
| M1 | Startup migrations need the runtime API role to hold DDL rights, which breaks least privilege. | Run `runMigrations` from a separate `migrate` command with the `pine_migrator` role. At API startup, only verify that the ledger equals the files and refuse to start if anything is pending or different (SEC-OPS-10). | P0 |
| M2 | `CREATE TABLE IF NOT EXISTS schema_migrations` runs outside the advisory lock. Concurrent first starts can race (Postgres `pg_type` unique violation). | Take `pg_advisory_lock` (or the xact lock in one transaction) before the CREATE. | P1 |
| M3 | Out-of-order application is silent: a new `0002` added after `0003` was applied is applied later. Ledger rows without files are ignored. | Fail if a pending file's number is below the group's max applied number. Fail on ledger entries with no file. | P1 |
| M4 | No `lock_timeout` or `statement_timeout`, so a migration waiting on a lock blocks traffic indefinitely. | `SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'` per file. | P2 |
| M5 | The checksum is computed over raw text, so CRLF conversion on Windows checkouts causes checksum mismatches. | `.gitattributes`: `*.sql text eol=lf`. | P2 |

### 11.5 `CLAUDE.md` and root configuration

| # | Issue | Fix | Sev |
|---|---|---|---|
| C1 | No pointer to these requirement IDs, so lanes cannot cite or test them consistently. | Add "Security requirements: `docs/security/requirements.md` (SEC-* IDs); each implemented requirement's negative test names its ID". | P0 |
| C2 | The SSRF rule ("no server-side fetching of user-supplied URLs") is ambiguous for IPFS-by-CID. | Clarify that fetches by content hash from configured gateways are allowed, with redirects disabled and the hash verified after download. | P1 |
| C3 | The Solidity rules omit reentrancy and token-hook guidance, which is critical on Gnosis (ERC-677). | Add `nonReentrant` on external-calling entrypoints, the immutable collateral allowlist, the receiver-hook restrictions and the zero-residual-balance invariant (SEC-SC-12..14). | P0 |
| C4 | CLAUDE.md mandates the deadline operator but does not freeze which operator applies to the commit, reveal and opening boundaries. | Freeze SEC-SC-07 in `contracts/src/interfaces/**` NatSpec. | P0 |
| C5 | Missing web rules: cookie attributes, CSRF, CORS, the separate user-content origin, no HTML/Markdown rendering, `trustProxy`, and log URL stripping. | Add a short "Web security" section that references SEC-AUTH/EVID/OPS. | P1 |
| C6 | `minimumReleaseAge: 4320` (3 days); pnpm ≥11 already defaults to 1440. `trustPolicy` is not set. | 10080, `trustPolicy: no-downgrade`, explicit `strictDepBuilds: true`, `blockExoticSubdeps: true` (SEC-OPS-12). | P1 |
| C7 | `@pine/api` runs production code through `tsx` (`node --import tsx`). | Build to `dist/` for production; keep `tsx` dev-only (SEC-OPS-13). | P2 |
| C8 | `foundry.toml` interpolates `${GNOSIS_RPC_URL}`; forge error output can print it. | Mask in CI and register it as a known secret (SEC-OPS-18). | P2 |
| C9 | CLAUDE.md references `docs/prd/` and `docs/adr/`, which do not exist yet. | Create them or fix the references so lanes do not invent locations. | P2 |

---

## 12. Open assumptions (safer reading chosen)

1. The frontend is served from the same origin as the API (`/api/v1`). If not, SEC-AUTH-16's cross-origin rules apply.
2. Collateral is a fixed, hook-free token (sDAI or WXDAI). Its hook behaviour must be confirmed on a Gnosis fork before inclusion in
   the allowlist.
3. The evidence registry design is commit-reveal plus direct submission, with commits allowed strictly before the deadline and reveals
   in a bounded window that ends before the Reality opening time.
4. ERC-1271 and ERC-6492 logins are disabled until a human decision (SEC-LEGAL-10.10).
5. GitHub App with zero permissions is the default choice, pending spike SEC-GH-02.
6. Session lifetimes in SEC-AUTH-12 are defaults for confirmation, not fixed policy.

## 13. Sources (primary unless noted)

- GitHub Docs — authenticating with a GitHub App on behalf of a user; generating a user access token (PKCE, state, expiry 8 h/6 mo):
  https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user ,
  https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
- GitHub Docs — refreshing user access tokens (single-use refresh): https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
- GitHub Docs — choosing permissions (implicit public read): https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- GitHub Docs — differences between GitHub Apps and OAuth apps: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
- GitHub Docs — OAuth scopes ("no scope"): https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
- GitHub Docs — authorizing OAuth apps (PKCE S256, state, 10-token limit, expiring tokens): https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- GitHub Docs — OAuth app access restrictions: https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions
- GitHub Docs — REST repos (`GET /user/repos`, `permissions`): https://docs.github.com/en/rest/repos/repos ; pulls (250-commit cap): https://docs.github.com/en/rest/pulls/pulls
- GitHub Docs — REST rate limits (5,000/h shared; secondary limits; ban warning): https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- GitHub Docs — webhook `github_app_authorization`: https://docs.github.com/en/webhooks/webhook-events-and-payloads
- GitHub Docs — forks and repository networks (shared Git data): https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/about-permissions-and-visibility-of-forks ; Truffle Security CFOR write-up: https://trufflesecurity.com/blog/anyone-can-access-deleted-and-private-repo-data-github
- EIP-4361 Sign-In with Ethereum: https://eips.ethereum.org/EIPS/eip-4361
- viem 2.57.0 sources (installed): `utils/uid.ts`, `utils/siwe/{parseSiweMessage,validateSiweMessage,generateSiweNonce}.ts`, `actions/siwe/verifySiweMessage.ts`, `actions/public/verifyHash.ts`
- OWASP CSRF Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- OWASP Session Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP File Upload Cheat Sheet (background): https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- Seer `MarketFactory.sol` (question encoding without escaping; question reuse; `NewMarket` event): https://github.com/seer-pm/demo/blob/main/contracts/src/MarketFactory.sol ; Reality question injection check PR: https://github.com/seer-pm/demo/pull/504
- Agave/Hundred Finance ERC-677 reentrancy on Gnosis (secondary analyses): https://medium.com/immunefi/a-poc-of-the-hundred-finance-heist-4121f23a098 , https://www.coindesk.com/business/2022/03/15/defi-lending-protocol-agave-plunges-over-20-amid-exploit-investigation
- Gnosis consensus parameters (5 s slots, 16-slot epochs, ~2-epoch finality): https://docs.analytics.gnosis.io/reference/glossary/ (secondary: https://hackmd.io/@dapplion/ryi_dDTro)
- Envio HyperIndex reorg support: https://docs.envio.dev/docs/HyperIndex/reorgs-support
- pnpm settings (minimumReleaseAge default 1440 since v11, trustPolicy, blockExoticSubdeps, allowBuilds, strictDepBuilds): https://pnpm.io/settings/dependency-resolution , https://pnpm.io/settings/build
