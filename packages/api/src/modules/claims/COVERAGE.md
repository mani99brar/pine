# claims module: coverage matrix (claims-hardening, PRD-07 §3b and §3e)

Every item of PRD-07 sections 3b and 3e mapped to the test that fails if the behaviour is removed. Format: `file` > test name.
All files are in this directory and run under the `unit` check (`vitest run src/modules/claims`). "Mutation" records a
run in which the named code was removed or moved and the listed test failed (all re-run in hardening-cl-002, 2026-10-03;
details under "Mutation evidence"). Every row was re-checked against the test body in hardening-cl-002.

## Cooperative abort (PRD-02 §2.5)

| Requirement | Test | Mutation (check removed → test fails) |
|---|---|---|
| Reconcile stops between publications; aborted before the run → nothing touched | `abort.test.ts` > aborted before the run: no publication is touched | `reconcile.ts` loop `if (signal?.aborted) break` |
| Reconcile aborted from inside a fake during the first publication → the second is untouched | `abort.test.ts` > aborted during the first publication: it completes, the second is untouched | same check |
| Integrity aborted before the run → nothing discovered, no pending row verified | `abort.test.ts` > aborted before the run: nothing is discovered and no pending row is verified | `integrity.ts` discovery `if (signal?.aborted) throw` |
| Discovery stops between pages (the next page is never read, nothing inserted) | `abort.test.ts` > discovery aborted during the first page: the next page is never read and nothing is inserted | same check |
| Verification stops between claims | `abort.test.ts` > verification aborted during the first claim: it completes, the second stays pending and unattempted | `verifyPendingClaims` loop check |
| backfillParameters stops between rows | `abort.test.ts` > the parameters backfill aborted during the first row: it completes, the second stays unchecked | `backfillParameters` loop check |
| flushAudit stops between entries; unrecorded rows stay in the outbox | `outbox.test.ts` > an abort between entries stops the flush and leaves the unrecorded rows in the outbox | `audit.ts` `flushOnce` per-row check |

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
| A hint-mined (finalized receipt) publication is never reopened, refetched, expired or failed | `reconcile.test.ts` > a finalized mined publication is never reopened: its recorded success later missing from the node changes nothing and offers no plan |
| A hint receipt counts only at or below the covered block | `reconcile.test.ts` > a hint's receipt counts only at or below the read model's covered block; a newer one stays unknown and is fetched again (existing) |

## Audit atomicity (SEC-OPS-07)

Audited claims writes: publication created (second statement of the insert transaction), tx hint reported (CTE on the
hint INSERT), the transitions submitted / mined (request: CTE; reconcile via hint: second statement of the hint
transaction) / confirmed / failed / expired (CTE), and integrity verdicts verified / mismatch (second statement of the
`writeResult` transaction). Details are unchanged (no outbox id). The flush runs at the start of every claims job run, after
each audited write and on a same-key replay (POST /publications for an existing row, POST /submitted with a known hash).

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
| Reconcile hint→`mined` (hint status, transition and outbox INSERT in one transaction; finalized succeeded receipt) | the reconcile hint→mined transaction (finalized succeeded receipt): refused outbox row → state submitted, hint unknown, outbox unchanged |
| Reconcile `confirmed` transition (CTE through `move`; `failed`/`expired` use the same `move` call site) | the reconcile confirmed transition (CTE): refused outbox row → state planned, no market, outbox unchanged |
| Integrity verdict (second statement of the `writeResult` transaction) | the integrity verdict (writeResult transaction): refused outbox row → the claim stays pending and not final, outbox unchanged |

## Operator-settled choices (kept from hardening-cl-001; bind this lane)

- The publish-time repository recheck keeps consuming one `github_calls_per_hour` unit (a real upstream call); the SEC-GH-12
  refusal (owner/name changed) is 409 and returns no plan.
- Finality instead of reopen: `mined` only from finalized evidence (the indexed market, or a succeeded hint whose receipt is
  at or below the read model's covered block); reconcile step 2a (reopen) is removed and a `mined` publication is never
  reopened; a latest-only `marketOf` hit never moves the state and POST /publications answers 503 NOT_READY,
  retryAfterSeconds 30, no plan.
- The tests listed under "Rewritten tests" encode behaviour §3b replaced; no other test of main changed.
- Claims audit rule: the audited write and its outbox INSERT commit in the same transaction (a second statement inside the
  existing `ctx.db.transaction` for the publication insert, hint + mined and `writeResult`; a CTE for bare single-statement
  writes), so statement shapes and the lock-order trace test stay unchanged.
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
| `reconcile.test.ts` > a finalized mined publication is never reopened … (was "a mined publication whose recorded success disappears returns to the plan-able state …") | reopen (step 2a) removed |
| `reconcile.test.ts` > a latest-block marketOf hit never moves the state … (was "a request-side mined publication whose on-chain market disappears returns to planned") | same |

Lane-own test changed in hardening-cl-002 (not a test of main): the combined `outbox.test.ts` > "an audited write whose
outbox row cannot be written does not happen (same statement or transaction)" of hardening-cl-001 was replaced by the seven
per-write §3e tests above (it did not reach the `submitted`, request-side `mined` or reconcile hint→`mined` writes and did
not assert the outbox or hint status).

## Mutation evidence

Each row: the code removed, reverted or moved, the test run (`VITEST_MAX_WORKERS=1 vitest run <file> -t <pattern>`) and the
tests that failed. All rows were run in hardening-cl-002 (2026-10-03) against the candidate code; the file was restored
after each run (byte-compared).

| Mutation | Failing tests |
|---|---|
| `reconcile.ts` per-publication `if (signal?.aborted) break` removed | `abort.test.ts` > aborted before the run: no publication is touched; > aborted during the first publication … |
| `integrity.ts` discovery per-page `if (signal?.aborted) throw` removed | `abort.test.ts` > aborted before the run: nothing is discovered …; > discovery aborted during the first page … |
| `verifyPendingClaims` per-row check removed | `abort.test.ts` > verification aborted during the first claim … |
| `backfillParameters` per-row check removed | `abort.test.ts` > the parameters backfill aborted during the first row … |
| `flushOnce` per-row check removed | `outbox.test.ts` > an abort between entries stops the flush … |
| `flushAudit` single flight bypassed (direct `flushOnce`) | `outbox.test.ts` > in-process concurrent flushes record each entry once …; > a flush requested while one runs … |
| A call during a running flush returns the running flush (no flush again) | `outbox.test.ts` > a flush requested while one runs waits for it and then flushes again … |
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
| §3e: reconcile hint→mined outbox INSERT moved after its transaction commits | `outbox.test.ts` > … atomicity … > the reconcile hint→mined transaction … |
| §3e: integrity `writeResult` outbox INSERT moved after its transaction commits | `outbox.test.ts` > … atomicity … > the integrity verdict … |
