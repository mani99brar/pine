# PRD-01: Chain contracts (feature `chain`)

Implements ADR-0001 D2–D4 and the SEC-SC requirements of `docs/security/requirements.md`. Interfaces are frozen:
`contracts/src/interfaces/IClaimRegistry.sol`, `IEvidenceRegistry.sol`, `external/ISeer.sol`. Cross-language vectors are frozen in
`packages/shared/src/testing/vectors.ts`. Toolchain: Foundry 1.8.1, solc 0.8.37, EVM cancun, vendored forge-std 1.17.0 and
OpenZeppelin 5.7.0 (`contracts/lib`, never edited). Tests print a TAP summary through `node scripts/forge-test-tap.mjs [forge args]`.

## 1. Lanes and ownership

| Lane | Owns (path prefixes) |
|---|---|
| `claim-registry` | `contracts/src/ClaimRegistry.sol`, `contracts/src/libraries`, `contracts/test/claim-registry`, `contracts/test/fork`, `contracts/script` |
| `evidence-registry` | `contracts/src/EvidenceRegistry.sol`, `contracts/test/evidence-registry` |

Neither lane edits interfaces, `contracts/lib`, `contracts/foundry.toml`, `scripts/`, or anything under `packages/`. Each lane's tests
must pass with only its own files present (worker phase): `claim-registry` tests use a test-local mock evidence registry; the
`evidence-registry` tests use a test-local mock claim registry implementing the parts of `IClaimRegistry` they need. Both are
then re-run together on the combined candidate.

## 2. ClaimRegistry (`claim-registry` lane)

### 2.1 Constructor
`constructor(address seerMarketFactory, address evidenceRegistry, uint256 minimumMinBond, ExpectedSeer memory expected)` where
`ExpectedSeer { address realitio; address arbitrator; address realityProxy; address conditionalTokens; address wrapped1155Factory; address collateralToken; uint32 questionTimeout; }` (a struct declared in `ClaimRegistry.sol`). It reverts unless:
- `seerMarketFactory.code.length > 0` and `evidenceRegistry.code.length > 0`;
- `IEvidenceRegistry(evidenceRegistry).claimRegistry() == address(this)`;
- every `ISeerMarketFactory` getter equals the corresponding `expected` field (`realitio()`, `arbitrator()`, `realityProxy()`,
  `conditionalTokens()`, `wrapped1155Factory()`, `collateralToken()`, `questionTimeout()`);
- `0 < minimumMinBond <= MAX_MIN_BOND`.
Store factory, evidence registry, minimumMinBond and `block.chainid` as immutables. No other state can ever be configured.

### 2.2 Constants
`MIN_EVIDENCE_WINDOW = 1 days`, `MAX_EVIDENCE_WINDOW = 90 days`, `MIN_REVEAL_WINDOW = 12 hours`, `MAX_REVEAL_WINDOW = 7 days`,
`MAX_TITLE_BYTES = 120`, `MAX_MIN_BOND = 10_000 ether` (declared `public constant`; the interface getters return them).

### 2.3 createClaim (nonReentrant, checks-effects-interactions as far as the market address allows)
1. Validate (each failure its specific custom error from the interface): nonzero `claimDocumentSha256`, `policyDocumentSha256`,
   `repositoryId`, `commit` (`ZeroValue`); `block.timestamp + MIN_EVIDENCE_WINDOW <= evidenceDeadline <= block.timestamp +
   MAX_EVIDENCE_WINDOW` (`EvidenceDeadlineOutOfRange(value, earliest, latest)`); `evidenceDeadline + MIN_REVEAL_WINDOW <=
   revealDeadline <= evidenceDeadline + MAX_REVEAL_WINDOW` and `revealDeadline <= type(uint32).max`
   (`RevealDeadlineOutOfRange`); `minBond >= minimumMinBond` (`MinBondTooLow(minBond, minimumMinBond)`) and
   `minBond <= MAX_MIN_BOND` (`MinBondTooHigh(minBond, MAX_MIN_BOND)`); title 1..120 bytes
   (`TitleLength`), each byte in 0x20..0x7E except `"` (0x22) and `\` (0x5C) (`TitleForbiddenByte(index)`).
2. Duplicate check: `marketOf(msg.sender, claimDocumentSha256) == address(0)` else `DuplicateClaim(existing)`.
3. Compose `marketName = renderQuestion(params)` (2.4) and the token names `["PY_" + hex8, "PN_" + hex8]` where hex8 is the first
   4 bytes of `claimDocumentSha256` as lowercase hex.
4. Call `ISeerMarketFactory.createCategoricalMarket` with: `marketName`, outcomes `["Yes","No"]`, `questionStart`/`questionEnd`/
   `outcomeType` empty, `parentOutcome 0`, `parentMarket address(0)`, category `"misc"`, lang `"en_US"`, bounds 0, `minBond`,
   `openingTime = uint32(revealDeadline)` (SafeCast), token names as above.
5. Verify the returned market (`UnexpectedMarketShape(market)` otherwise): `templateId() == 2`, `numOutcomes() == 2`,
   `questionsIds().length == 1`, `keccak256(bytes(marketName()))` equals the composed question, and
   `encodedQuestions(0)` equals `marketName ␟ "Yes","No" ␟ misc ␟ en_US` (U+241F separators, exactly as Seer encodes);
   read `conditionId()`, `questionsIds()[0]`, `wrappedOutcome(0..2)` (token addresses).
6. Record the `Claim` (creator = msg.sender, createdAt = block.timestamp, all fields, `marketNameHash`, tokens), set the
   `(creator, digest) -> market` index, increment `claimCount`, emit `ClaimCreated(market, creator, digest, claim, title, marketName)`.
   If the returned market address is already recorded (impossible with the real factory), revert `UnexpectedMarketShape(market)`.

### 2.4 renderQuestion (view, same validation as createClaim)
Exactly the template in the interface NatSpec, byte-identical to `packages/shared/src/question.ts` for every entry of
`QUESTION_VECTORS`. The question is pasted raw by Seer into Reality template 2's JSON, so it never contains `"`, `\` or control
characters (the title is delimited by brackets). `renderQuestion` performs the full `createClaim` validation, including the
windows relative to `block.timestamp` and the min-bond bounds; the TypeScript twin checks only the format rules. Therefore the
vector tests exercise the composition through a test-harness contract that calls the library's pure composition function
directly with the vector's evidence-registry address, and additionally run at least one vector through the deployed
`renderQuestion` (with `vm.warp` so its deadlines are valid and a registry bound to that evidence-registry address, e.g. via
`vm.etch` of the mock). Helpers live in `contracts/src/libraries/` (pure, internal):
- `formatUtc(uint64)` → `YYYY-MM-DD HH:MM:SS` (civil-from-days algorithm), matching `UTC_FORMAT_VECTORS` (incl. leap days, 2100,
  and 2^32−1).
- `rawCid(bytes32)` → `"b" + base32-lower(0x01 0x55 0x12 0x20 || digest)` (59 chars), matching `RAW_CID_VECTORS`.
- lowercase hex of addresses, commits and digests; decimal of `repositoryId`.
Vectors are transcribed into a Solidity test file by the lane (Solidity tests cannot read files: `fs_permissions = []`).

### 2.5 Views
`getClaim` (reverts `UnknownMarket`), `isRegistered`, `marketOf`, `claimCount`, `evidenceRegistry`, `seerMarketFactory`,
`minimumMinBond`, the constants. No function iterates storage.

## 3. EvidenceRegistry (`evidence-registry` lane)
- `constructor(address claimRegistry)`: stores it immutably (nonzero). No other configuration.
- `commitEvidence(market, commitment)`: market registered (`IClaimRegistry.isRegistered`, else `UnknownMarket`); deadline from
  `getClaim`; `block.timestamp < evidenceDeadline` else `EvidenceWindowClosed`; `commitment != 0` else `ZeroValue`; new id
  `++submissionCount`; store `{market, submitter: msg.sender, committedAt, status: Committed, commitment}`; emit.
- `revealEvidence(id, contentSha256, salt)`: id issued (`UnknownSubmission`); `msg.sender == submitter` (`NotSubmitter`); status
  Committed (`WrongStatus`); `block.timestamp < revealDeadline` (`RevealWindowClosed`); nonzero digest and salt (`ZeroValue`);
  recomputed commitment equals the stored one (`CommitmentMismatch`); set Revealed, `revealedAt`, `contentSha256`; emit.
- `publishEvidence(market, contentSha256)`: registered market, `block.timestamp < evidenceDeadline`, nonzero digest; status
  Published with `revealedAt = committedAt = block.timestamp`; emit.
- `computeCommitment` per the interface (TYPEHASH from the interface NatSpec); `getSubmission` (reverts `UnknownSubmission` for 0 and
  ids above the count); `submissionCount`; `claimRegistry`; `COMMITMENT_TYPEHASH`.
- No loops, no external calls other than staticcalls to the immutable registry; `nonReentrant` is not required but harmless.

## 4. Required tests
### claim-registry (`contracts/test/claim-registry`, with test-local mocks of Seer factory/market and evidence registry)
- Every validation error, with exact boundary values (earliest/latest accepted, one second outside rejected) for both windows,
  min bond floor and cap, title length 1/120/121 and every forbidden byte class (control, 0x7F, `"`, `\`, a UTF-8 multibyte).
- Duplicate per creator reverts; same digest from another creator succeeds (two markets).
- `renderQuestion` equals every `QUESTION_VECTORS` entry; `formatUtc`, `rawCid` and token names equal their vectors; fuzz tests:
  `formatUtc` round-trips against a naive reference for random uint32 values, `rawCid` against a bit-by-bit reference encoder.
- `ClaimCreated` fields and `getClaim` contents; `UnexpectedMarketShape` for each malformed mock market (template 3, 3 outcomes,
  2 questions, wrong name, wrong encoded question); reentrancy: a mock factory that calls back into `createClaim` reverts.
- Constructor: each mismatched expected Seer value, missing code, and a wrong evidence-registry binding revert.
### fork (`contracts/test/fork`, Gnosis pinned at block 48550000, RPC `vm.envOr("GNOSIS_RPC_URL", string("https://rpc.gnosischain.com"))`, which serves archive state — verified 2026-10-02; `gnosis-rpc.publicnode.com` does not)
- Deploy a mock evidence registry at the predicted address and the ClaimRegistry against the real Seer factory with the
  `GNOSIS_EXTERNAL` values; `createClaim` creates a real market: Reality `getTimeout == 302400`, `getOpeningTS == revealDeadline`,
  `getMinBond == minBond`, `getArbitrator == 0x68154E…`; CTF outcome slot count 3; wrapped token names `PY_…`/`PN_…`;
  `marketName()` equals `renderQuestion`; a second creator publishing the same digest gets a distinct market that shares the
  Reality question, the condition **and the three wrapped outcome-token addresses** (Wrapped1155Factory deploys wrappers by CREATE2
  over the position id and token data, and the token names are identical); the test asserts this sharing explicitly. Nothing may
  treat an outcome-token address as unique per claim. The fork tests never broadcast and need no key.
### evidence-registry (`contracts/test/evidence-registry`, with a test-local mock claim registry)
- `computeCommitment` reproduces `EVIDENCE_COMMITMENT_VECTOR` (deploy at the vector's registry address with `deployCodeTo`,
  `vm.chainId(100)`).
- Boundary warps at deadline−1 / deadline / deadline+1 for commit, publish and reveal.
- Front-running: an attacker commits the victim's commitment hash first; the victim's commit still succeeds with its own id; the
  attacker's reveal of the victim's preimage reverts `CommitmentMismatch`; the victim's reveal succeeds.
- Double reveal, reveal by another address, reveal of a published id, zero salt/digest/commitment, unknown market and unknown id revert.
- Invariant test (handler-based): ids are 1..count with no gaps, statuses only move Committed→Revealed, published records never change.
- Gas: commit/reveal gas does not grow with the number of prior submissions (assert within a small tolerance after 500 submissions).

## 5. Deployment script (`claim-registry` lane, `contracts/script/Deploy.s.sol`)
Takes the deployer explicitly (`vm.startBroadcast(deployer)`), predicts the ClaimRegistry address with
`vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1)`, reads the expected Seer addresses from the script (copied from
`GNOSIS_EXTERNAL`), deploys EvidenceRegistry(predicted) then ClaimRegistry, asserts the binding and every expected address, and logs
a JSON deployment record (addresses, block, chain id, constructor args). It is only run by an operator (`forge script --broadcast`
with a hardware wallet); a fork test runs the script's logic with an explicit test deployer without broadcasting.

Note for the evidence-registry vector test: `deployCodeTo` needs the artifact in the sparse `--match-path` compilation, which holds
when the test imports `EvidenceRegistry.sol`; otherwise deploy normally and `vm.etch` the runtime code at the vector's registry
address (safe: `computeCommitment` uses `address(this)` and the only immutable is the claim registry).

## 6. Checks (controller-run, per lane)
- build: `forge build --root contracts` (kind build).
- unit: `node scripts/forge-test-tap.mjs --match-path "test/<lane-dir>/**"` (kind unit).
- fork (claim-registry only): `node scripts/forge-test-tap.mjs --match-path "test/fork/**"` (kind integration).
- abi: `node scripts/export-abis.mjs --check` after the build (kind typecheck).
- forbidden: `node scripts/check-forbidden.mjs` (kind unit; no proxy/admin/pause primitives).

## 7. Out of scope
Any change to interfaces, vectors, the TypeScript packages, mainnet deployment, LP locks, orchestrators, upgradeability.
