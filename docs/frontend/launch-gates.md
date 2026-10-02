# Launch gates: how the frontends handle each one

SPEC §10 lists decisions that must be made before launch. The frontends do not pretend these are resolved. Each gate is either made **configurable**, shown to users as an **open item**, or **defaulted** to a documented placeholder that must be confirmed. All three apps render this list from `COPY.launchGates` (`@pine/core/copy`) on their Risks / launch-gates page.

| # | Gate (SPEC §10) | Frontend treatment | Where |
|---|---|---|---|
| 1 | Target PR/commit and selected claim | Any public commit can be selected. The keeper example is the flagship demo fixture | composer source step; `@pine/data` fixtures |
| 2 | Meaning of the $5 budget, fee inclusions, minimum viable funding | The spending limit is an explicit total cap that includes every fee counted toward it. Low-liquidity warnings say depth may be too thin to attract investigation. No minimum is enforced | `estimateFunding` warnings; composer funding step |
| 3 | Chain, collateral, Seer deployment, fees | Chain config is data (`chains.ts`), and each entry carries a `verified` flag. Unverified chains show a warning before publishing | `@pine/core/chains`; review step |
| 4 | Immutable policy representation and Seer/Reality/Kleros compatibility | The question embeds commit, environment hash and policy id@version (hash). The market description references the manifest URI and hash. The manifest JSON Schema is published | `buildQuestion`, `buildMarketDescription`, `/api/agent/v1/schema/claim-manifest.json` |
| 5 | Submission mechanism, timestamp proof, availability, front-running | Default is ERC-1497 evidence on the arbitrator proxy, with the block timestamp as proof. Commit-reveal mode is offered and marked as a launch gate | `EVIDENCE_MECHANISMS`; evidence submission page |
| 6 | Investigation duration | Default 72h (the proposal). It is adjustable within 24h–180d, and arbitration can take longer, which the UI says | composer deadlines step; `validateClaimDraft` |
| 7 | Oracle answering, monitoring, escalation funding | Cost lines show the oracle bond and arbitration fee as `reserved`, along with who pays. The claim page shows answer and bond status, and the next actor | funding breakdown; claim oracle view |
| 8 | Liquidity shape, withdrawal constraints, max loss | Price range and initial price are inputs. LP positions are labelled withdrawable and are never presented as a guaranteed reward. "Exposed to loss" is shown explicitly | funding step; dashboard LP positions |
| 9 | Safe reproduction environment, fault models | Environment pin with hashes, fault model and allowed inputs are required fields. Evidence content is treated as untrusted and rendered inert | composer; evidence rendering |
| 10 | Fee model, auth, stack, hosting, ownership | Decided for the frontend: Next.js 16, GitHub OAuth (`read:user`) + SIWE, no platform fee in this release. Hosting is documented in `deployment.md` | this repo |
| 11 | First enabled policy families; live-security disclosure | FUNC-001 and BOT-001 are enabled. SC-001 is shown but gated, and publishing it is blocked | policy catalog; `validateClaimDraft` |
| 12 | Pilot comparison vs bounty and conventional review | Out of scope for the UI. Activity and evidence data are exposed through the agent API and indexer contracts so the pilot can be measured | agent API; indexer contracts |
