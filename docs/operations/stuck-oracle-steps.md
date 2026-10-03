# Stuck oracle steps (due actions)

Pine runs **no keeper** and holds no keys: it never answers, bonds, finalizes, resolves or pays arbitration fees.
Resolution depends on interested parties sending the permissionless transactions Pine plans for them (ADR-0001 D7). The
oracle status route lists what is possible now:

```
GET /api/v1/markets/<market>/oracle[?account=<wallet>]
  -> phase (evidence_open | reveal_open | oracle_open | pending_arbitration | finalized | resolved), status, dueActions[]
```

The response is cached for 10 s per market and account (`computedAt` is the time it was computed), so a just-mined
transaction can take up to 10 s to show. At most 4 cache misses per API process read the chain at once; another one is
refused at once with `429 RATE_LIMITED` and `Retry-After` (never queued).

| dueAction | Meaning | Plan route |
|---|---|---|
| `answer` | question open (reveal deadline passed): post an answer with bond >= max(minBond, 2 x current bond) | `POST /api/v1/oracle/plans/submit-answer` |
| `fund_bounty` | add a bounty to attract answerers | `POST /api/v1/oracle/plans/fund-bounty` |
| `request_arbitration_on_ethereum` | dispute the current answer through Kleros (Ethereum mainnet, paid in ETH; no Pine plan) | instructions only |
| `handle_notified_request` / `handle_rejected_request` | relay a Kleros request state from the home proxy | `POST /api/v1/oracle/plans/handle-notified-request` / `handle-rejected-request` |
| `report_arbitration_answer` | report the arbitrator's answer to Reality | `POST /api/v1/oracle/plans/report-arbitration-answer` |
| `reopen_question` | the question settled as "answered too soon": re-ask it | `POST /api/v1/oracle/plans/reopen` |
| `resolve_market` | finalized: resolve the Seer market so outcome tokens redeem | `POST /api/v1/oracle/plans/resolve` |
| `claim_winnings` / `withdraw` | bond holders collect | `POST /api/v1/oracle/plans/claim-winnings` / `withdraw` |

## When a claim is stuck

1. Confirm the read model is fresh (`freshness.status` = `ok` in the response). If not, fix the indexer first.
2. `phase = oracle_open`, `status.state = open_unanswered` long after the reveal deadline: nobody answered. Remind the
   claim creator and evidence submitters (the `markets.watch` job already sent them an `answers_open` notification;
   later ones are `finalization_soon`, `arbitration_<stage>`, `finalized` with the due actions, and `resolved`). Pine
   staff do not answer from a Pine wallet (conflict of interest, SEC-LEGAL-07).
3. `answered`, finalization time passed but status still `answered`: check that the indexer is not halted; `finalizeTs`
   comes from the indexed answer plus the question timeout (302400 s).
4. `finalized` without `resolution`: anyone can send the resolve plan; remind the interested parties. A resolution only
   appears after `ConditionResolution` is indexed.
5. `pending_arbitration` for weeks: Kleros arbitration takes ~16-20 days; check the foreign proxy on Ethereum and that the
   home-proxy relay steps (`handle_*_request`, `report_arbitration_answer`) were sent.
6. `reopen_question`: Reality's "answered too soon" outcome; the reopen plan re-creates the identical question; the
   oracle route then follows the replacement (`currentQuestionId`). Until the indexer links the replacement to the
   claim's question, the route answers `503 NOT_READY` instead of trusting the RPC's id alone.
7. If a due action is listed but its plan route refuses (422 with a reason), the indexed history may disagree with
   Reality (`claim_winnings`, `report`): wait for the indexer to catch up; persistent mismatch -> incident.
