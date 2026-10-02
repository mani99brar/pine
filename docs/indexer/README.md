# Pine indexer contracts

Status: contracts and client adapters only. **No indexer is implemented in this repository.** The frontends read every piece of chain and off-chain state through one interface, `PineDataProvider` (`packages/data/src/types.ts`), and `@pine/data` ships three adapters for it:

| Adapter | Source | Contract | Client |
|---|---|---|---|
| `mock` (default) | Demo fixtures, no network | — | `MockDataProvider` |
| `rest` | A REST indexer + write API you operate | [`rest-api.openapi.yaml`](rest-api.openapi.yaml) (OpenAPI 3.1) | `RestDataProvider`, `RestDraftStore`, `RestAccountStore` |
| `envio` | An Envio HyperIndex v3 deployment (hosted Hasura GraphQL) | [`envio/schema.graphql`](envio/schema.graphql), [`envio/config.example.yaml`](envio/config.example.yaml) | `EnvioDataProvider` |

Chain facts (addresses, events, timeouts, costs) come from [`docs/research/seer-integration.md`](../research/seer-integration.md). Re-verify them before launch.

## Choosing REST or Envio

| Question | REST indexer | Envio HyperIndex |
|---|---|---|
| What you run | Your own service (any stack) that indexes chain events **and** stores off-chain records | An Envio indexer from the config and schema here; Envio Cloud can host it |
| Effort to stand up | Higher: indexing, API, auth, storage | Lower: handlers plus Envio hosting |
| Drafts, accounts, linked wallets, preferences | Server-side (`/drafts`, `/accounts`), shared across devices | Browser-local (`localStorage`) only |
| Partially published claims (`publishing`, `failed`) | Visible to everyone through `publication` | Only in the creator's browser (draft store); on-chain the market looks unfunded |
| Lifecycle status | Computed server-side | Derived client-side from indexed facts at the current time (same rules as `@pine/core` `deriveStatus`) |
| Manifest | Embedded in `GET /claims/{id}` | The `Claim.manifest` JSON when the handler stored it, otherwise fetched from IPFS by the client |
| Depth | Server-computed executable depth (ticks or quotes) | Approximated from the pool's active liquidity (constant L near the price) |
| `PlatformStats.openClaims` | Exact | Counted from a `Claim` id query, capped at 1000 (Envio Cloud has no aggregates). A fresh indexer without the `PlatformStats` row reports zeros |
| Policies | `GET /policies` (may serve newer catalog versions) | The `@pine/core` catalog compiled into the app |
| `creatorGithub`, rich `tags` | Yes (server joins accounts) | No (`creatorGithub` absent; tags = policy family and claim class) |
| `settled` status (viewer has nothing left to redeem) | Can be computed per viewer | Not derived; shows as `resolved` |
| Notifications | Possible (server-side) | Not available |
| Rate limits | Yours | Envio plan limits (Seer throttles to ~250 req/min) |

**Recommendation.** Use **Envio** for a read-only public explorer or an early pilot. Use **REST** for the full product: drafts and publication recovery that survive device changes, account preferences, and notifications. A REST service can itself be built on top of an Envio indexer (Envio for chain state, a small database for drafts and accounts).

## Pointing an app at each source

All three apps read the same variables (`readPineEnv()` in `@pine/data`):

| Variable | Used by | Meaning |
|---|---|---|
| `NEXT_PUBLIC_PINE_DATA_SOURCE` | all | `mock` (default) \| `rest` \| `envio` |
| `NEXT_PUBLIC_PINE_API_URL` | rest | Base URL including the version, e.g. `https://api.pine.example/v1` |
| `NEXT_PUBLIC_ENVIO_GRAPHQL_URL` | envio | e.g. `https://indexer.hyperindex.xyz/<hash>/v1/graphql`, or `http://localhost:8080/v1/graphql` |
| `NEXT_PUBLIC_IPFS_GATEWAY` | rest, envio | Manifest and evidence reads (default `https://cdn.kleros.link`) |
| `PINE_IPFS_UPLOAD_URL`, `PINE_IPFS_UPLOAD_TOKEN` | server | Pinning endpoint used by the app's `/api/ipfs` route |
| `NEXT_PUBLIC_CHAIN_ID` | all | Default chain (100) |
| `NEXT_PUBLIC_PINE_DEMO_WALLET` | all | `1` forces the simulated wallet; it is on automatically in mock mode |
| `NEXT_PUBLIC_PINE_MOCK_LATENCY` | mock | `0` disables the simulated 120–420 ms latency |

A misconfiguration falls back to mock rather than crashing: `rest` without an API URL, or `envio` without a GraphQL URL, runs in mock mode.

```bash
# REST
NEXT_PUBLIC_PINE_DATA_SOURCE=rest NEXT_PUBLIC_PINE_API_URL=https://api.pine.example/v1 pnpm dev:console
# Envio
NEXT_PUBLIC_PINE_DATA_SOURCE=envio NEXT_PUBLIC_ENVIO_GRAPHQL_URL=http://localhost:8080/v1/graphql pnpm dev:docket
```

In code:

```ts
import { createDataProvider, createDraftStore, createAccountStore, createManifestStorage, readPineEnv } from '@pine/data'
const env = readPineEnv()
const data = createDataProvider(env)                         // mock | rest | envio
const drafts = createDraftStore(env, { getToken })           // rest → /drafts; otherwise localStorage (memory on the server)
const accounts = createAccountStore(env, { getToken })       // rest → /accounts; otherwise local
const storage = createManifestStorage(env)                   // mock → in-memory CIDs; otherwise IPFS via /api/ipfs + gateway
```

Demo fixtures are built lazily (on first read, then once per hour), so `rest` and `envio` deployments never compute them. Their source is still part of the `@pine/data` bundle.

Every adapter throws `PineDataError` with a code (`network`, `not_found`, `bad_response`, `unauthorized`, `rate_limited`, `unsupported`) and resolves single-resource misses to `null`.

## REST contract

[`rest-api.openapi.yaml`](rest-api.openapi.yaml) is generated by `packages/data/scripts/openapi-spec.ts` (`pnpm --filter @pine/data openapi`). Its response examples are built from the demo fixtures through the same domain↔wire mappers the client uses. The data package tests validate every example against its schema (ajv, JSON Schema 2020-12) and round-trip it through the mappers and `RestDataProvider`.

- **Reads:** `GET /claims` (repeatable `status`, `outcome`, `policy_id`, `family`, `repo`, `creator`, `chain_id`, `search`, `sort`, `cursor`, `limit`), `/claims/{id}`, `/markets/{chain_id}/{address}/claim`, `/claims/{id}/prices?range=`, `/claims/{id}/depth?outcome=`, `/claims/{id}/evidence`, `/activity` (`claim_id`, `account`, repeatable `types`, `cursor`, `limit`), `/portfolio/{address}`, `/policies`, `/policies/{id}?version=`, `/stats`.
- **Writes (bearer):** `/drafts?owner=`, `GET|PUT|DELETE /drafts/{id}`, `GET|PUT|DELETE /accounts/{login}`, `POST /accounts/{login}/wallets`, `DELETE /accounts/{login}/wallets/{address}`, `POST /accounts/{login}/wallets/{address}/primary`, `PATCH /accounts/{login}/preferences`, `GET /accounts/{login}/export`.
- **Wire format:** read-model envelopes are snake_case, and optional values may be `null`. Immutable or user-authored documents are embedded **verbatim** in camelCase: `manifest` (hashed, so never re-key it), policy `parameters`, and draft `source`/`spec`/`funding`/`publication`. Price history is `[t_ms, yes, no, volume]` tuples. Depth is `bids`/`asks` arrays of `[price, cumulative_size]`.
- **Errors:** `{ "error": { "code", "message" } }`. 404 on single resources maps to `null` in the client.

## Envio contract

- [`envio/schema.graphql`](envio/schema.graphql): `Claim`, `Market`, `Outcome`, `Pool`, `PriceCandle` (hourly), `Trade`, `LiquidityPosition`, `Position`, `Evidence`, `OracleQuestion`, `OracleAnswer`, `Arbitration`, `ActivityEvent`, `Account`, `PlatformStats` (singleton `"global"`), `DailyStats`. Ids follow Seer's indexer: `"<chainId>:<lowercase hex>"`, `"<chainId>:<txHash>:<logIndex>"` for logs.
- [`envio/config.example.yaml`](envio/config.example.yaml): v3 `chains:` for Gnosis (100) and Ethereum (1). It indexes MarketFactory `NewMarket`; Reality `LogNewQuestion`, `LogNewAnswer`, `LogNotifyOfArbitrationRequest`, `LogFinalize`, `LogCancelArbitration`, `LogReopenQuestion` and `LogAnswerReveal`; ConditionalTokens `PositionSplit`, `PositionsMerge`, `PayoutRedemption` and `ConditionResolution`; outcome-token `Transfer`; Swapr/Algebra `Pool`, `Swap`, `Mint`, `Burn` and position-manager events; the home proxy's `RequestNotified`, `RequestRejected` and `ArbitratorAnswered` on Gnosis; and on Ethereum the foreign proxy's `ArbitrationRequested`, `ArbitrationCreated`, `ArbitrationFailed`, `Ruling` and ERC-1497 `Evidence`, plus KlerosLiquid period events.

**How Pine claims are recognized.** A market is a Pine claim when it was created by the official MarketFactory and its name ends with `" — Terms: ipfs://<cid> (manifest keccak256 0x…)"` (`@pine/core` `buildMarketName`). The `NewMarket` handler fetches the manifest with Envio's Effect API (`createEffect` + `context.effect`). It verifies `keccak256(canonicalJson(manifest))` and that the market name begins with `manifest.question.text`, then writes the `Claim` with denormalized fields for filtering and search.

The client verifies the terms again. A manifest from `Claim.manifest` or from IPFS must hash to `Claim.manifestHash`, and `manifestValid: false` is rejected (`PineDataError('bad_response')`), so unverified content is never shown as a claim's terms.

Evidence on Ethereum is linked by `_evidenceGroupID = uint256(realityQuestionId)` and can arrive before the claim is known. Both `getClaim` and `listEvidence` therefore query `Evidence` by `questionId`. A package the indexer could not read is shown as a neutral item ("Evidence package not yet read by the indexer"), never as a counterexample, and its content hash is the zero hash (unverified), never a value derived from the URI.

**Status derivation (client).**

| Indexed facts | Status |
|---|---|
| `phase=open`, deadline in the future | `open` |
| `phase=open`, deadline passed; or answer timed out as `too_soon` (must be reopened) | `awaiting_answer` |
| `phase=answered`, `finalizeTs` in the future | `answer_proposed` |
| `phase=disputed`, `finalizeTs` in the future | `disputed` |
| `phase=arbitration` | `arbitration` (`appeal_period` while `appealPeriodEnd` is in the future) |
| `phase=finalized` with `outcome` (or a valid `currentAnswer`); or answered/disputed with `finalizeTs` passed and a valid answer | `resolved` with `outcome` |
| `phase=finalized` without a valid answer | `awaiting_answer` |

The same table is used to build server-side `where` filters (`statusWhere` in `packages/data/src/envio/mappers.ts`). `draft`, `publishing` and `failed` never exist on-chain, so filters for them return nothing.

**Query style.** The client sends Hasura queries: `Claim(where: {...}, order_by: [{createdAt: desc}], limit, offset)`, `Claim(where: {claimId: {_eq: "pine-0009"}})` for detail, `PriceCandle(where: {claim_id: {_eq: …}, periodStart: {_gte: …}})`, `Evidence(where: {questionId: {_eq: …}})`, `ActivityEvent(where: {claim: {claimId: {_eq: …}}})`, `Account_by_pk(id:)`, `PlatformStats_by_pk(id: "global")` and `DailyStats(...)`. Pagination is offset-based and probes with `limit + 1`. `BigInt`/`BigDecimal` values are passed and returned as strings. Sort `deadline` is plain ascending `evidenceDeadlineTs`. Hasura cannot express "upcoming first, then past" (mock and REST do), so combine it with `status: 'open'` for a "closing soon" list.

## What the frontend reads (field mapping)

Domain types are in `packages/core/src/types.ts`. "—" means not available from that source. Envio paths are relative to `Claim` unless noted.

### ClaimSummary

| Domain field | REST wire | Envio |
|---|---|---|
| `id` | `id` | `claimId` |
| `number` | `number` | `number` |
| `title`, `violation` | `title`, `violation` | `title`, `violation` |
| `policy.{id,version,family,title}` | `policy.{id,version,family,title}` | `policyId`, `policyVersion`, `policyFamily`, `policyTitle` |
| `source.{owner,repo,commitSha,prNumber,prTitle}` | `source.{owner,repo,commit_sha,pr_number,pr_title}` | `repoOwner`, `repoName`, `commitSha`, `prNumber`, `prTitle` |
| `status`, `outcome` | `status`, `outcome` | derived from `phase`, `evidenceDeadlineTs`, `finalizeTs`, `currentAnswer`, `outcome` |
| `createdAt` | `created_at` | `createdAt` (unix s → ISO) |
| `evidenceDeadline` | `evidence_deadline` | `evidenceDeadlineTs` |
| `chainId`, `marketAddress` | `chain_id`, `market_address` | `chainId`, `market.address` |
| `creator`, `creatorGithub` | `creator`, `creator_github` | `creator`, — |
| `yesPrice`, `yesPrice24hAgo` | `yes_price`, `yes_price_24h_ago` | `yesPrice`, `yesPrice24hAgo` |
| `liquidity`, `volume` | `liquidity`, `volume` | `liquidity`, `volume` |
| `collateralSymbol` | `collateral_symbol` | `market.collateralSymbol` |
| `evidenceCount`, `traders` | `evidence_count`, `traders` | `evidenceCount`, `traders` |
| `sponsored` | `sponsored` | `sponsored` (sponsor wallet list in the indexer) |
| `tags` | `tags` | policy family + manifest `claimClass` |

### ClaimDetail (in addition)

| Domain field | REST wire | Envio |
|---|---|---|
| `manifest`, `manifestUri`, `manifestHash` | `manifest` (verbatim), `manifest_uri`, `manifest_hash` | `manifest` JSON or IPFS(`manifestUri`), `manifestUri`, `manifestHash` |
| `market.{address,seerUrl,conditionId,questionId,collateral}` | `market.{address,seer_url,condition_id,question_id,collateral}` | `market.{address,conditionId,questionId,collateralToken,collateralSymbol}`; Seer URL built client-side |
| `market.outcomes[]` | `market.outcomes[]{index,label,token,price,change_24h}` | `market.outcomes[]{index,label,token,price,change24h}` |
| `market.pools[]` | `market.pools[]{address,dex,outcome,tvl,fee_bps}` | `market.pools[]{address,dex,outcomeIndex,tvlCollateral,feeBps}` (invalid-outcome pool hidden) |
| `market.{liquidity,volume24h,volumeTotal,traders,openInterest,createdAt,createdTx}` | `market.{…}` | `liquidity`, `volume24h`, `volume`, `traders`, `openInterest`, `market.blockTimestamp`, `market.txHash` |
| `oracle.{realityQuestionId,realityUrl,templateId,openingTime,timeoutSeconds,minBond,bondToken}` | `oracle.{reality_question_id,reality_url,template_id,opening_time,timeout_seconds,min_bond,bond_token}` | `question.{questionId,templateId,openingTs,timeout,minBond}`; URL and bond token from `@pine/core` chains |
| `oracle.{currentAnswer,currentBond,finalizesAt,isFinalized,finalAnswer}` | `oracle.{current_answer,current_bond,finalizes_at,is_finalized,final_answer}` | `currentAnswer`, `question.bond`, `question.finalizeTs`, derived, `outcome` |
| `oracle.history[]` | `oracle.history[]{answer,bond,answerer,at,tx_hash}` | `question.answers[]{answer,bond,user,timestamp,txHash}` |
| `oracle.arbitration` | `oracle.arbitration{requested,requested_at,requester,dispute_id,court,cost,status,ruling,appeal_deadline,kleros_url}` | `question.arbitration{requester,requestedAt,disputeId,court,cost,status,ruling,rulingAt,appealPeriodEnd}`; Kleros URL built client-side |
| `evidence[]` | `evidence[]` (see Evidence) | `evidence[]` |
| `timeline[]` | `timeline[]{id,kind,at,title,detail,actor,tx_hash,scheduled}` | built client-side from market creation, liquidity activity, evidence, deadline, opening, answers, arbitration and finalization |
| `publication` | `publication{steps[],resumable,note}` | — (creator's local draft store) |
| `funding` | `funding{liquidity,spending_limit,withdrawable}` | — |

### Evidence, prices, depth, activity, portfolio, stats

| Domain | REST wire | Envio |
|---|---|---|
| `Evidence.{id,claimId,kind,title,summary}` | `id, claim_id, kind, title, summary` | `id`, `claim.claimId` / ref, `kind`, `title`, `summary` (hydrated by Effect; placeholders until then) |
| `Evidence.{submitter,submittedAt,blockNumber,txHash,chainId}` | `submitter, submitted_at, block_number, tx_hash, chain_id` | `party`, `timestamp`, `blockNumber`, `txHash`, `chainId` (1 for Gnosis markets) |
| `Evidence.{uri,contentHash,timely}` | `uri, content_hash, timely` | `uri`, `contentHash`, `timely` (or `timestamp <= evidenceDeadlineTs`) |
| `Evidence.{reproduction,attachments,commitment}` | `reproduction, attachments, commitment` | JSON fields, shape-checked by the client |
| `PricePoint{t,yes,no,volume}` | `points[[t,yes,no,volume]]` | `PriceCandle{periodStart*1000, yesClose, noClose, volume}` |
| `DepthSnapshot` | `{outcome, mid, at, bids, asks}` | `Pool{sqrtPriceX96, liquidity, outcomeIsToken0, price}` → approximation |
| `ActivityItem` | `Activity{…}` snake_case | `ActivityEvent{type, actor, timestamp, txHash, chainId, amount, token, outcome, side, summary, claimNumber, claimTitle, claim.claimId}` |
| `Portfolio.positions[]` | `positions[]` | `Account.positions[]{outcomeIndex, balance, avgPrice, claim{…prices, phase}}`; mark price and redeemability derived |
| `Portfolio.liquidity[]` | `liquidity[]` | `Account.liquidityPositions[]{tokenId, outcomeIndex, depositedCollateral, currentValue, feesEarned, inRange, pool.address}` |
| `Portfolio.totals` | `totals` | `Account.{depositedAllTime, withdrawnAllTime, feesPaidAllTime}` plus sums |
| `PlatformStats` | `Stats` | `PlatformStats("global")`, `DailyStats` (last 30 days), open-claim id count |
| `PolicyVersion` | `Policy` | `@pine/core` `POLICIES` |

## Upload route used by `createManifestStorage` (rest/envio modes)

In the browser, `putJson(value, name)` sends `POST /api/ipfs?name=<name>` with the canonical JSON as the body. The `@pine/server` route pins the canonical bytes and returns `{ uri, cid, hash, gatewayUrl, size, pinned, mock }`. The client rejects the response if `hash` differs from its own `hashJson(value)`. Server-side, with `PINE_IPFS_UPLOAD_URL` set, the canonical bytes are posted as multipart `file` with `Authorization: Bearer $PINE_IPFS_UPLOAD_TOKEN`. Reads go through `NEXT_PUBLIC_IPFS_GATEWAY`.

## Open items (launch gates)

- Verify the Algebra v1 pool and position-manager event signatures, and decide between exact depth (tick data or Seer Lens quotes) and the active-liquidity approximation.
- Run the permissionless relay steps for arbitration (`handleNotifiedRequest`, `reportArbitrationAnswer`), or confirm Kleros bots cover Seer's proxies. Otherwise questions can stay frozen.
- Decide the evidence hydration policy: gateway fallbacks, maximum size, and content that is never fetched or rendered as HTML. Evidence is untrusted.
- Decide the sponsor wallet list (`PINE_SPONSOR_ADDRESSES`) and how sponsorship is disclosed.
- REST: the auth token format between the app server and the API, CORS for reads, and retention for exports and deletion.
