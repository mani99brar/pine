# claims module: coverage matrix (claims-hardening, PRD-07 §3b, §3e, §3f and §3g)

Every item of PRD-07 sections 3b, 3e, 3f and 3g mapped to the test that fails if the behaviour is removed. Format: `file` > test
name. All files are in this directory and run under the `unit` check (`vitest run src/modules/claims`). "Mutation" records
a run in which the named code was removed or moved and the listed test failed (§3b/§3e rows run in hardening-cl-002; the §3f
rows and every row whose code or test §3f touched re-run in hardening-cl-003, 2026-10-03; the §3g rows and the request-path
flush rows re-run in hardening-cl-004; details under "Mutation evidence"). Every row §3f touches was re-checked against the
test body in hardening-cl-003; in hardening-cl-004 every row of this matrix was re-checked against the test it names (name
present, and the test body asserts what the row claims).

## Cooperative abort (PRD-02 §2.5)

| Requirement | Test | Mutation (check removed → test fails) |
|---|---|---|
| Reconcile stops between publications; aborted before the run → nothing touched | `abort.test.ts` > aborted before the run: no publication is touched | `reconcile.ts` loop `if (signal?.aborted) break` |
| Reconcile aborted from inside a fake during the first publication → the second is untouched | `abort.test.ts` > aborted during the first publication: it completes, the second is untouched | same check |
| Integrity aborted before the run → nothing discovered, no pending row verified | `abort.test.ts` > aborted before the run: nothing is discovered and no pending row is verified | `integrity.ts` discovery `if (signal?.aborted) throw` |
| Discovery stops between pages (the next page is never read, nothing inserted) | `abort.test.ts` > discovery aborted during the first page: the next page is never read and nothing is inserted | same check |
| Verification stops between claims | `abort.test.ts` > verification aborted during the first claim: it completes, the second stays pending and unattempted | `verifyPendingClaims` loop check |
| backfillParameters stops between rows | `abort.test.ts` > the parameters backfill aborted during the first row: it completes, the second stays unchecked | `backfillParameters` loop check |
| flushAudit stops between entries; unrecorded rows stay in the outbox | `outbox.test.ts` > an abort between entries stops the flush and leaves the unrecorded rows in the outbox | `audit.ts` `flushOnce` per-row check (re-run on the §3f flush, cl-003) |

## Policy-text pinning

| Requirement | Test |
|---|---|
| After a plan is returned the content store holds the catalog policy bytes under their digest (new row and existing row) | `publication.test.ts` > stores (pins) the digest-verified policy text next to the claim document before a plan is returned, on both paths |
| A failing put returns no plan (503 NOT_READY, Retry-After) | `publication.test.ts` > a failing policy-text put is 503 NOT_READY without a plan; once the store recovers the retry gets the plan |

## SEC-GH-12 at publish

| Requirement | Test |
|---|---|
| Owner login or name differing (renamed / transferred) → 409 "repository changed since preview; create a new preview", no plan, no row, no publication quota, one `github_calls_per_hour` unit; case-insensitive | `publication.test.ts` > SEC-GH-12 a repository renamed or transferred since the preview is 409 without a plan or row (one GitHub unit); a case-only difference passes |
| Same on the existing-row path (one GitHub unit, no plan) | `publication.test.ts` > SEC-GH-12 on the existing-row path: a retry after a rename is 409 without a plan and consumes one GitHub unit |

## New-row path after the plan offer expired

| Requirement | Test |
|---|---|
| First POST after planExpiresAt → 409 "plan offer expired; create a new preview", no GitHub unit (`github_calls_per_hour` unchanged), no `publications_per_day`, no row | `publication.test.ts` > after the plan offer expires a retry returns planExpired without a plan (24 h preview cap) (rewritten part) |
| Existing-row order: publish, repository private or GitHub rate-limited, past planExpiresAt → 200, plan null, planExpired true, no GitHub call (no unit, no `getRepoById`) | `publication.test.ts` > existing-row order: after the plan offer expired a retry is 200 with planExpired and no plan, without asking GitHub (private or rate-limited) |

## Integrity: creation receipt

| Requirement | Test |
|---|---|
| `claimCreatedMarkets(receipt, claim.registry, claim.creator, claim.claimDocumentSha256)` must include `claim.market`, else mismatch on `creation` (creator, registry, digest, market variants) | `integrity.test.ts` > the creation receipt must prove the read model's creator, registry and digest for the market: otherwise a mismatch on creation |
| A null receipt keeps the claim pending with backoff (no verdict, no audit) | `integrity.test.ts` > a missing creation receipt is transient: the claim stays pending with backoff, never a verdict |
| An RPC failure fetching the receipt is transient | `integrity.test.ts` > a verification failure for one claim does not stop the others; it stays pending and is verified later (existing) |

## Verification starvation

| Requirement | Test |
|---|---|
| Up to 50 never-attempted rows (oldest first) AND up to 50 retries (by next_attempt_at): 60 always-due unavailable rows plus one new claim → the new claim is verified in the first run | `integrity.test.ts` > 60 always-due retries of unavailable documents cannot crowd out a new claim: it is verified in the first run |
| Never-attempted rows still at most 50 per run, oldest first | `integrity.test.ts` > verifies at most 50 claims per run, oldest first (existing) |

## Finality instead of reopen

| Requirement | Test |
|---|---|
| A latest-only `marketOf` hit on the request path → 503 NOT_READY (Retry-After 30), state unchanged, no plan; `mined` only once indexed | `publication.test.ts` > a retry after the claim exists: a latest-block marketOf hit alone is 503 NOT_READY (no plan, state unchanged); mined only once indexed |
| Same under a no-longer-publishable policy | `publication.test.ts` > a retry after the policy stopped being publishable: 503 NOT_READY while the claim is only at the latest block, then the indexed market without a plan |
| Same on the existing-row path with a private repository: no GitHub call | `publication.test.ts` > the recheck runs on the existing-row path after the chain re-check: an on-chain claim is answered without a plan or GitHub call even if the repository is private |
| A latest-only hit never moves the state in reconcile; a publication mined from the finalized read model is never reopened | `reconcile.test.ts` > a latest-block marketOf hit never moves the state; a publication mined from the finalized read model is never reopened |
| A final succeeded hint is never reopened, refetched, expired or failed; it withholds the plan (since §3f a hint no longer makes `mined`) | `reconcile.test.ts` > a final succeeded hint is never reopened: its success later missing from the node changes nothing and offers no plan (rewritten in cl-003) |
| A hint receipt counts only at or below F (harness default F = indexedBlock) | `reconcile.test.ts` > a hint's receipt counts only at or below the read model's covered block; a newer one stays unknown and is fetched again (final assertion rewritten in cl-003); the F ≠ indexedBlock cases are in §3f below |

## Finality of every final decision (PRD-07 §3f, SEC-IDX-01, SEC-IDX-06)

One bound per reconcile run and per request: F = `status().finalizedBlock` ?? `await ctx.chain.finalizedBlock()` (null on
failure: no final decision), `finality.ts` `finalityOf`; every irreversible decision goes through `isFinal(block) = F !== null
&& block <= F`. The read model's `indexedBlock` is never finality. The request path computes F only when the read model
serves the claim; a reconcile run computes it once when it has open publications. Expiry coverage is the timestamp of
min(indexedBlock, F): `indexedBlockTimestamp` when `isFinal(indexedBlock)`, otherwise the timestamp of block F (one
`eth_getBlockByNumber` per run, only when an otherwise expirable publication needs it; a failure means no expiry).
The hint→mined transaction is gone: a final hint only sets its own status (`succeeded` withholds the plan with 503 NOT_READY,
retryAfterSeconds 30, and holds back expiry; `reverted` leads to `failed` once coverage is final).

| Requirement | Test (`finality.test.ts` > finality of claims decisions (PRD-07 §3f) > …, unless named) |
|---|---|
| Reconcile `confirmed`: Envio-like status (finalizedBlock null) with the claim above the chain's finalized block → not confirmed (receipt not even fetched); at it → confirmed | reconcile confirmed: an Envio-like status (finalizedBlock null) with the claim above the chain's finalized block → not confirmed; at it → confirmed |
| Reconcile `confirmed`: a native finalizedBlock below the claim (indexedBlock above it) → not confirmed, chain not asked (status F preferred) | reconcile confirmed: a native status whose finalizedBlock lies below the claim is not final although indexedBlock covers it (indexedBlock is never finality) |
| Request-path `mined`: Envio-like, claim above F → 503 NOT_READY (Retry-After 30), state unchanged, no plan, no audit; at or below F → `mined`, no plan | request-path mined: an Envio-like status with the claim above F → 503 NOT_READY, state unchanged, no plan; at or below F → mined without a plan |
| Request-path `mined`: native finalizedBlock below the indexed claim → 503, not mined | request-path mined: a native status whose finalizedBlock lies below the indexed claim → 503 NOT_READY, not mined |
| `finalizedBlock()` failure → no final decision (request 503, reconcile unchanged); recovers when the node answers | a finalizedBlock() failure (Envio-like status) means no final decision: request 503 and reconcile leave the publication unchanged |
| Hint `succeeded`/`reverted` only at or below F (native F below the receipts with indexedBlock above them, then Envio-like F); at F both final; the state is unchanged | hints: a succeeded or reverted receipt above F stays unknown even at or below indexedBlock (native and Envio-like F); at F both become final |
| A final succeeded receipt whose claim the read model does not serve → no plan (503), not mined (request and reconcile) | a final succeeded receipt whose claim the read model does not serve → no plan (503 NOT_READY), not mined, by request or reconcile |
| Expiry coverage only up to F (Envio-like): block F before the cutoff → open; F unknown → open; F at the cutoff → open; F after it → expired | expiry coverage counts only up to F: an Envio-like read model past the cutoff does not expire while block F is before it; F's block after it → expired |
| Expiry coverage with a native finalizedBlock below indexedBlock uses block F's timestamp | expiry coverage with a native status whose finalized block lies below the indexed block uses block F's timestamp |
| The hint→mined transaction is dropped (a succeeded hint is no audited write and moves nothing) | `outbox.test.ts` > a final succeeded hint is not an audited write (the hint→mined transaction is gone, PRD-07 §3f) …; `reconcile.test.ts` > a successful reported hash with the expected log only marks its hint succeeded (no mined, no plan), then confirmed once indexed |
| Harness default: markFresh / markIndexedAt pass finalized = indexedBlock (native-like); the Envio fallback is scripted only in the new tests (`ChainScript.finalized`) | `test/helpers.ts`; every existing finality-dependent test (confirm, mined, hints, expiry) runs on this default unchanged |

## Integrity finality (PRD-07 §3g, SEC-IDX-01)

`verifyPendingClaims` computes one bound F per integrity run (the same `finalityOf`: `status().finalizedBlock` ??
`ctx.chain.finalizedBlock()`, null on failure), lazily when the first due claim needs it, and evaluates a claim only when
`isFinal(claim.createdBlock)`; otherwise it throws a TransientError ("claim creation not final") before any receipt or
content lookup, so the row keeps its status (`pending`) with the usual backoff and no audit entry. The gate sits before
`evaluateClaim`, so no verdict of any kind (verified, mismatch, document_unavailable) is written for a non-final claim.
`backfillParameters` only touches rows already `verified` (final). With the harness default (finalized = indexedBlock, all
test claims below it) the existing integrity tests keep their meaning unchanged.

| Requirement | Test (`finality.test.ts` > integrity finality (PRD-07 §3g, SEC-IDX-01) > …) |
|---|---|
| Envio-like status (finalizedBlock null), claims above the chain's finalized block → pending, attempts 1, backoff 60 s, no audit, no receipt fetched; F at the first claim's block → verified (at F) while the second stays pending (backoff 120 s); F above the second → mismatch; one `eth_getBlockByNumber` per run for two claims | an Envio-like status with the claims above the chain's finalized block → pending with backoff, no verdict; at or below F → verified and mismatch (one F per run) |
| Native finalizedBlock below the claim (indexedBlock above it) → pending, chain not asked; `finalizedBlock()` failure → pending; at F → verified | a native finalizedBlock below the claim (indexedBlock above it) and a finalizedBlock() failure keep the claim pending; at F → verified |

## Request-path audit flush and outbox ids (PRD-07 §3f)

POST /publications and POST /publications/:id/submitted call `flushAuditInBackground` (the markets pattern, copied: one
in-flight promise per database handle plus a coalesced rerun flag, cleared in `finally`; errors caught and logged through
`safeErrorMessage(…, ctx.redact)`); jobs still await `flushAudit`. The claims test helpers wrap every test app's inject to
await `settledAudit` after the response (requesting no extra drain); `rawInject` skips that wait.

| Requirement | Test (`finality.test.ts` > request-path audit flush and outbox ids (PRD-07 §3f) > …) |
|---|---|
| A never-resolving audit store does not delay POST /publications (new row with a plan: the flush after `createOrReusePublication`) nor POST /publications/:id/submitted (both its flushes) (raw inject, 5 s guard); the entries are recorded once it resolves | SEC-OPS-07 an audit store that never resolves does not delay POST /publications or POST /publications/:id/submitted |
| §3g: POST /publications for an existing row that the final read model serves reaches the request-side `mined` transition; a never-resolving audit store does not delay it (the flush after the `mined` transition; the earlier flush finds an empty outbox, so this test isolates the second call site) | SEC-OPS-07 (PRD-07 §3g) an audit store that never resolves does not delay POST /publications for an existing row the final read model serves (the flush after the mined transition) |
| §3g: a first POST /publications whose claim the final read model already serves inserts the row and moves it to `mined` in one request; a never-resolving audit store delays neither flush (after `createOrReusePublication`, with the created entry pending, and after the `mined` transition) | SEC-OPS-07 (PRD-07 §3g) an audit store that never resolves does not delay a first POST /publications that the final read model moves to mined (both flush call sites) |
| A rejecting background flush never fails the response; it is logged once, redacted | SEC-OPS-07 a failing background flush never fails the response and is logged redacted |
| A rejected drain never wedges later flushes (single-flight entry cleared on rejection) | a drain that rejects once never wedges later flushes (the single-flight entry is cleared on rejection too) |
| Harness rule: the helpers' inject waits for the request's flush, a raw inject does not | harness rule: a claims test inject returns only after the flush its request started (a slow audit store), a raw inject does not wait |
| `outboxSelect` generates one id per row (`gen_random_uuid()` in SQL): a two-row source → two rows, distinct ids | outboxSelect gives each row of its source its own outbox id (a source returning two rows → two rows, two ids) |

## Audit atomicity (SEC-OPS-07)

Audited claims writes: publication created (second statement of the insert transaction), tx hint reported (CTE on the
hint INSERT), the transitions submitted / mined (request only since §3f: CTE) / confirmed / failed / expired (CTE), and
integrity verdicts verified / mismatch (second statement of the `writeResult` transaction). Details are unchanged (no outbox
id). The flush runs at the start of every claims job run, after each audited write and on a same-key replay (POST
/publications for an existing row, POST /submitted with a known hash); on the request path it is started without being
awaited (§3f), jobs await it.

Guarantee: **at-least-once**. A crash between `record` and the row's `DELETE`, or a flusher in another process reading the
same rows, can only duplicate an entry, never lose one. Duplicates are identified by the natural key: (action, subjectId),
plus `details.txHash` for `claim.publication.tx_reported`. In-process flushes are single-flight per database handle.
Rows written in one request with the same clock time (tx_reported and submitted) have no defined relative order when
they are recorded after an outage.

| Requirement | Test |
|---|---|
| Audit gateway throws once → row remains; recorded exactly once by the next flush after a later write; row deleted; details unchanged | `outbox.test.ts` > the audit gateway throws once at publication: the plan is returned, the row stays, and the next write records it exactly once |
| … after a same-key replay | `outbox.test.ts` > a same-key replay records an entry an outage left pending, exactly once |
| … after a reconcile run with no open publication (flush before any early return) | `outbox.test.ts` > a reconcile run with no open publication records a transition entry an outage left pending |
| … integrity verdicts, by the next integrity run | `outbox.test.ts` > an integrity verdict whose audit fails is recorded once by the next integrity run |
| Several pending entries for one publication all survive an outage | `outbox.test.ts` > several pending entries for one publication all survive an outage and are each recorded once, in order, afterwards |
| Abort between entries leaves the unrecorded rows | `outbox.test.ts` > an abort between entries stops the flush and leaves the unrecorded rows in the outbox |
| Single flight: concurrent in-process flushes never double-record | `outbox.test.ts` > in-process concurrent flushes record each entry once (single flight per database handle); `reconcile.test.ts` > concurrent runs apply each transition once; `integrity.test.ts` > concurrent runs record each result once |
| A call while a flush runs waits and flushes again | `outbox.test.ts` > a flush requested while one runs waits for it and then flushes again (a row written meanwhile is recorded) |
| Statement shapes and lock-order trace unchanged | `publication.test.ts` > a first publication takes FOR SHARE on the draft row (at the previewed revision) before its insert; a retry locks nothing (existing, unchanged) |
| Harness truncates `claims_audit_outbox` per test | `test/helpers.ts` `useHarness` (every outbox test asserts exact counts from an empty outbox) |

### Outbox atomicity (PRD-07 §3e, coverage P1)

Each test adds `CHECK (false) NOT VALID` to `claims_audit_outbox` (binds only new rows), drives one audited write, asserts
the publication state and market, the hint statuses and the outbox are exactly as before (snapshot equality), then drops the
constraint and shows the same step now succeeds (so the refused run did reach the write). Each test fails if its outbox
INSERT is moved out of the write's statement or transaction (mutation evidence below: the write commits, the separate INSERT
fails).

| Audited write (how its outbox row commits) | Test (`outbox.test.ts` > claims audit outbox atomicity (SEC-OPS-07, PRD-07 §3e) > …) |
|---|---|
| Publication insert (second statement of the insert transaction) | the publication insert: refused outbox row → 500, no publication row, outbox unchanged |
| tx_reported hint (CTE on the hint INSERT) | the tx_reported hint (CTE): refused outbox row → 500, no hint, state planned, outbox unchanged |
| `submitted` transition (CTE in `transitionPublication`); reached with `CHECK ((entry->>'action') <> 'claim.publication.submitted')`, so the hint CTE succeeds | the submitted transition (CTE): with only its outbox row refused the hint is kept, the state stays planned and the outbox unchanged |
| Request-side `mined` transition (CTE), market indexed in the finalized read model | the request-side mined transition (CTE): refused outbox row → 500, state planned, no market, outbox unchanged |
| (Removed in §3f: the reconcile hint→`mined` transaction no longer exists; a final succeeded hint sets only its own status, which is no audited write) | a final succeeded hint is not an audited write (the hint→mined transaction is gone, PRD-07 §3f): with the outbox refused it still becomes succeeded, state submitted, outbox unchanged |
| Reconcile `confirmed` transition (CTE through `move`; `failed`/`expired` use the same `move` call site) | the reconcile confirmed transition (CTE): refused outbox row → state planned, no market, outbox unchanged |
| Integrity verdict (second statement of the `writeResult` transaction) | the integrity verdict (writeResult transaction): refused outbox row → the claim stays pending and not final, outbox unchanged |

## Operator-settled choices (kept from hardening-cl-001, cl-002 and cl-003, extended by §3g; bind this lane)

- The publish-time repository recheck keeps consuming one `github_calls_per_hour` unit (a real upstream call); the SEC-GH-12
  refusal (owner/name changed) is 409 and returns no plan.
- Finality instead of reopen: reconcile step 2a (reopen) is removed and a `mined` publication is never reopened; a
  latest-only `marketOf` hit never moves the state and POST /publications answers 503 NOT_READY, retryAfterSeconds 30, no
  plan.
- §3f (operator decision after the design challenge): one bound F = `status().finalizedBlock` ?? `ctx.chain.finalizedBlock()`
  (null on failure) per reconcile run and per request; every irreversible decision (request `mined`, reconcile `confirmed`,
  hint `succeeded`/`reverted`, expiry coverage) goes through `isFinal(block) = F !== null && block <= F`; `indexedBlock` is
  never finality; the hint→mined transaction is dropped (a hint only sets its own status and withholds the plan or holds
  back expiry). `mined` therefore comes only from the request path with the read model serving the claim in a final block.
- §3f harness default (operator decision): markFresh / markIndexedAt pass finalized = indexedBlock (native-like); the Envio
  fallback (`eth_getBlockByNumber` 'finalized') is scripted only in new tests.
- §3g integrity finality: a verdict is written only when `isFinal(claim.createdBlock)` with the §3f bound F (one per
  integrity run); otherwise the claim stays pending with backoff. The gate is before `evaluateClaim` (no receipt or content
  lookup and no `document_unavailable` either for a non-final claim).
- §3f request path: POST /publications and POST /publications/:id/submitted flush in the background (markets
  flushAuditInBackground / settledAudit / rawInject pattern copied unchanged); the claims test helpers await the module's
  single-flight flush after each response.
- The tests listed under "Rewritten tests" encode behaviour §3b or §3f replaced; no other test of main changed.
- Claims audit rule: the audited write and its outbox INSERT commit in the same transaction (a second statement inside the
  existing `ctx.db.transaction` for the publication insert and `writeResult`; a CTE for bare single-statement writes), so
  statement shapes and the lock-order trace test stay unchanged. (The hint + mined transaction was removed in §3f.)
- At-least-once, details unchanged (no outbox id), duplicates identified by the natural key; `ctx.audit` is used only
  through the frozen `AuditLog.record`.
- The claims test harness truncates `claims_audit_outbox` per test.
- §3e refusal technique: `CHECK (false) NOT VALID` on `claims_audit_outbox`; the `submitted` transition is reached with an
  action-specific constraint that lets the hint CTE succeed.
- Hardening decisions (2026-10-02): ClaimRegistry is final as merged; claims are keyed only by registry addresses (never by
  token names); verification uses `VITEST_MAX_WORKERS=1`.

## Rewritten tests (operator decision, PRD-07 §3b)

| Test | Reason |
|---|---|
| `publication.test.ts` > a retry after the claim exists: a latest-block marketOf hit alone is 503 NOT_READY … (was "… latest-block marketOf or the read model") | a latest-only hit no longer moves to `mined` |
| `publication.test.ts` > after the plan offer expires … (its "first request after expiry" part) | new-row path after expiry is now 409 CONFLICT |
| `publication.test.ts` > audits the request-side transitions: created, submitted, mined (on request) | `mined` on request now comes only from the indexed claim |
| `publication.test.ts` > a retry after the policy stopped being publishable: 503 NOT_READY … (was "… returns the on-chain market without a plan") | same |
| `publication.test.ts` > SEC-GH-13 a GitHub outage at publish … (recovery assertion) | asserts status 200 and a non-null, verified plan (`not.toBeNull()` alone passed on an error body) |
| `publication.test.ts` > the recheck runs on the existing-row path after the chain re-check … | latest-only → 503 without a GitHub call; mined once indexed |
| `reconcile.test.ts` > a final succeeded hint is never reopened … (cl-002 name "a finalized mined publication is never reopened …"; originally "a mined publication whose recorded success disappears returns to the plan-able state …") | reopen (step 2a) removed; renamed and rewritten again in cl-003 (§3f) |
| `reconcile.test.ts` > a latest-block marketOf hit never moves the state … (was "a request-side mined publication whose on-chain market disappears returns to planned") | same |

### Rewritten in hardening-cl-003 (PRD-07 §3f: a hint receipt alone never makes `mined`)

| Test | Reason |
|---|---|
| `reconcile.test.ts` > a successful reported hash with the expected log only marks its hint succeeded (no mined, no plan), then confirmed once indexed (was "… moves to mined (still not final), then confirmed once indexed") | the hint→mined transaction is dropped; asserts `submitted`, hint `succeeded`, 503 NOT_READY, then `confirmed` |
| `reconcile.test.ts` > every reconcile transition writes its audit entry once: confirmed, failed, expired (a succeeded hint audits nothing) (was "… mined, confirmed, failed, expired") | no reconcile `mined` entry; `confirmed` now comes `from: "submitted"` |
| `reconcile.test.ts` > never expires or fails a publication once a recorded hash has a successful matching receipt, even after coverage passed | expected `mined`; now `submitted` (the succeeded hint holds back expiry but moves nothing) |
| `reconcile.test.ts` > a hint's receipt counts only at or below the read model's covered block; … (final assertion) | expected `mined` once the receipt is final; now both hints final (`succeeded`, `reverted`) and the state `submitted` |
| `reconcile.test.ts` > a final succeeded hint is never reopened: … (was "a finalized mined publication is never reopened: its recorded success …") | the publication can no longer be `mined` from the hint; asserts `submitted`, 503 without a plan, never refetched, never expired |
| `outbox.test.ts` > several pending entries for one publication all survive an outage … | five entries became four (no reconcile `mined`); lane-own test of cl-002 |
| `outbox.test.ts` > a final succeeded hint is not an audited write … (replaces "the reconcile hint→mined transaction (finalized succeeded receipt): …") | the transaction it tested was removed by §3f; lane-own test of cl-002 |

No other existing test changed; `test/helpers.ts` changed only by the harness default (finalized = indexedBlock), the
`ChainScript.finalized` script option, and the inject wrapper / `rawInject`.

Lane-own test changed in hardening-cl-002 (not a test of main): the combined `outbox.test.ts` > "an audited write whose
outbox row cannot be written does not happen (same statement or transaction)" of hardening-cl-001 was replaced by the seven
per-write §3e tests above (it did not reach the `submitted`, request-side `mined` or reconcile hint→`mined` writes and did
not assert the outbox or hint status).

## Mutation evidence

Each row: the code removed, reverted or moved, the test run (`VITEST_MAX_WORKERS=1 vitest run <file> -t <pattern>`) and the
tests that failed. Rows were run in hardening-cl-002 (2026-10-03) against that candidate; rows marked cl-003 were run in
hardening-cl-003 (2026-10-03) against that candidate; rows marked cl-004 were run in hardening-cl-004 (2026-10-03) against
this candidate. The file was restored after each run (byte-compared).

| Mutation | Failing tests |
|---|---|
| `reconcile.ts` per-publication `if (signal?.aborted) break` removed | `abort.test.ts` > aborted before the run: no publication is touched; > aborted during the first publication … |
| `integrity.ts` discovery per-page `if (signal?.aborted) throw` removed | `abort.test.ts` > aborted before the run: nothing is discovered …; > discovery aborted during the first page … |
| `verifyPendingClaims` per-row check removed | `abort.test.ts` > verification aborted during the first claim … |
| `backfillParameters` per-row check removed | `abort.test.ts` > the parameters backfill aborted during the first row … |
| `flushOnce` per-row check removed (cl-003, §3f flush) | `outbox.test.ts` > an abort between entries stops the flush … |
| `flushAudit` single flight bypassed (every call starts its own drain) (cl-003) | `outbox.test.ts` > in-process concurrent flushes record each entry once …; > a flush requested while one runs … |
| A call during a running flush returns the running flush (rerun flag ignored, no drain again) (cl-003) | `outbox.test.ts` > a flush requested while one runs waits for it and then flushes again … |
| Single-flight entry cleared only on success (no `finally`) (cl-003) | `finality.test.ts` > a drain that rejects once never wedges later flushes … |
| `storePolicyText` call removed | `publication.test.ts` > stores (pins) the digest-verified policy text …; > a failing policy-text put is 503 NOT_READY … |
| SEC-GH-12 owner/name refusal removed | `publication.test.ts` > SEC-GH-12 a repository renamed or transferred …; > SEC-GH-12 on the existing-row path … |
| New-row plan-offer expiry refusal removed | `publication.test.ts` > after the plan offer expires a retry returns planExpired without a plan (24 h preview cap) |
| `fields.add("creation")` removed | `integrity.test.ts` > the creation receipt must prove … |
| Work selection reverted to one query (oldest first, 50) | `integrity.test.ts` > 60 always-due retries of unavailable documents cannot crowd out a new claim … |
| Latest-block `marketOf` hit moves to `mined` again (request path) | `publication.test.ts` > a retry after the claim exists: a latest-block marketOf hit alone …; > a retry after the policy stopped being publishable …; > the recheck runs on the existing-row path … |
| Flush at the start of the reconcile run removed | `outbox.test.ts` > a reconcile run with no open publication records a transition entry an outage left pending |
| §3e: publication-created outbox INSERT moved after the insert transaction commits | `outbox.test.ts` > … atomicity … > the publication insert … |
| §3e: tx_reported outbox CTE split into a separate INSERT after the hint statement | `outbox.test.ts` > … atomicity … > the tx_reported hint (CTE) … |
| §3e: `transitionPublication` CTE split (UPDATE, then a separate outbox INSERT) | `outbox.test.ts` > … atomicity … > the submitted transition …; > the request-side mined transition …; > the reconcile confirmed transition … |
| §3e: only the `submitted` call site passes no audit and inserts its outbox row separately | `outbox.test.ts` > … atomicity … > the submitted transition … |
| §3e: only the request-side `mined` call site inserts its outbox row separately | `outbox.test.ts` > … atomicity … > the request-side mined transition … |
| §3e: only the reconcile `move` call site (confirmed/failed/expired) inserts its outbox row separately | `outbox.test.ts` > … atomicity … > the reconcile confirmed transition … |
| §3e: reconcile hint→mined outbox INSERT moved after its transaction commits | (cl-002; the transaction and its test were removed by §3f) |
| §3e: integrity `writeResult` outbox INSERT moved after its transaction commits | `outbox.test.ts` > … atomicity … > the integrity verdict … |
| §3f M1: request-path `isFinal(claim.createdBlock)` check removed (cl-003) | `finality.test.ts` > request-path mined: an Envio-like status …; > request-path mined: a native status …; > a finalizedBlock() failure … |
| §3f M2: reconcile step-1 `isFinal(claim.createdBlock)` check removed (cl-003) | `finality.test.ts` > reconcile confirmed: an Envio-like status …; > reconcile confirmed: a native status …; > a finalizedBlock() failure … |
| §3f M3: hint finality back to `receipt.blockNumber <= indexedBlock` (cl-003) | `finality.test.ts` > hints: a succeeded or reverted receipt above F stays unknown … |
| §3f M4: expiry coverage back to `indexedBlockTimestamp` (cl-003) | `finality.test.ts` > expiry coverage counts only up to F …; > expiry coverage with a native status … |
| §3f M5: chain fallback removed (F = status().finalizedBlock only) (cl-003) | `finality.test.ts` > reconcile confirmed: an Envio-like status …; > request-path mined: an Envio-like status …; > a finalizedBlock() failure …; > hints …; > expiry coverage counts only up to F … |
| §3f M6: `finalizedBlock()` failure not caught (cl-003) | `finality.test.ts` > a finalizedBlock() failure …; > expiry coverage counts only up to F … |
| §3f M7: succeeded-hint plan withholding removed (cl-003) | `finality.test.ts` > a final succeeded receipt whose claim the read model does not serve … |
| §3f M8: POST /publications awaits its flush (control: the same code not awaited passes) (cl-003; the flush after `createOrReusePublication`, the only call site that test reaches) | `finality.test.ts` > SEC-OPS-07 an audit store that never resolves … (5 s guard) |
| §3g G1: the flush after `createOrReusePublication` awaited (`await flushAudit(ctx)`) (cl-004) | `finality.test.ts` > SEC-OPS-07 an audit store that never resolves does not delay POST /publications or …/submitted; > SEC-OPS-07 (PRD-07 §3g) … a first POST /publications that the final read model moves to mined (both flush call sites); > SEC-OPS-07 a failing background flush never fails the response … (the §3g existing-row test passes: its first flush finds an empty outbox, so it isolates the second call site) |
| §3g G2: the flush after the request-side `mined` transition awaited (cl-004) | `finality.test.ts` > SEC-OPS-07 (PRD-07 §3g) … for an existing row the final read model serves (the flush after the mined transition); > SEC-OPS-07 (PRD-07 §3g) … a first POST /publications … (both flush call sites) (the cl-003 test passes under G2: it never reaches the `mined` transition, which was the coverage gap) |
| §3g G3: integrity `isFinal(claim.createdBlock)` gate removed (cl-004) | `finality.test.ts` > integrity finality … > an Envio-like status with the claims above the chain's finalized block …; > a native finalizedBlock below the claim … |
| §3g G4: integrity F computed per claim instead of once per run (`??=` → `=`) (cl-004) | `finality.test.ts` > integrity finality … > an Envio-like status … (one F per run: two `eth_getBlockByNumber` calls) |
| §3g G5: integrity gate on the read model's `indexedBlock` instead of F (cl-004) | `finality.test.ts` > integrity finality … > an Envio-like status …; > a native finalizedBlock below the claim … |
| §3f M8b/M8c: POST /submitted awaits its hint flush, or its transition flush (cl-003) | same test, each |
| §3f M9: `outboxSelect` back to one constant `randomUUID()` (cl-003) | `finality.test.ts` > outboxSelect gives each row of its source its own outbox id … |
| §3f M10: background flush failure logged without the redactor (cl-003) | `finality.test.ts` > SEC-OPS-07 a failing background flush never fails the response and is logged redacted |
| §3f M11: helpers no longer await `settledAudit` after inject (cl-003) | `finality.test.ts` > harness rule: … (the existing `publication.test.ts` and `outbox.test.ts` audit tests still passed under this mutation: with the in-memory audit store the background flush finishes before inject resolves, so the wrapper is a determinism guard) |
| §3f M12: reconcile hint→mined transition restored (cl-003) | `reconcile.test.ts` > the five rewritten tests listed under "Rewritten in hardening-cl-003" |
