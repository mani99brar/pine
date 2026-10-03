# Evidence takedown (SEC-EVID-12, SEC-OPS-06)

A human decides every takedown; the API only enforces it. Moderation never edits chain data or immutable documents: it
can **hide** a subject (excluded from listings and feeds, still retrievable by exact id with the reason) or **block** it
(bytes never served: the user-content host and the ERC-1497 route answer 451; claim details show metadata only).

## Intake

1. Record the request (who, what, legal basis, deadline) in the takedown log; acknowledge receipt.
2. Identify subjects: `content` (a sha256: claim document, manifest or artifact), `evidence`
   (`<evidenceRegistry>:<submissionId>`), `claim` (market address), `wallet`, `repository`.
3. Check the market phase (`GET /api/v1/markets/<market>/oracle`): evidence on a market that is still open, revealing,
   answered or under arbitration is part of an adjudication. Hiding is preferred while adjudication runs; block when the
   content is unlawful or harmful regardless (e.g. personal data, malware served as an artifact, a live exploit against
   a deployed system).
4. Legal hold: if the request concerns a dispute, keep the bytes (blocked, not deleted) and the audit trail.

## Action (admin wallet, fresh signature < 300 s)

```http
POST /api/v1/admin/moderation        {"subject":"content","id":"0x<sha256>","action":"block","reason":"takedown #123: <code>"}
GET  /api/v1/admin/moderation?subject=content
DELETE /api/v1/admin/moderation      {"subject":"content","id":"0x<sha256>","reason":"takedown #123 withdrawn"}
```

Every change writes `moderation.blocked`/`moderation.hidden`/`moderation.removed` to the audit log with the reason.
Admin rights come from `PINE_ADMIN_WALLETS` and are re-checked on every request.

## After

- Verify: `https://<user-content host>/c/0x<sha256>` answers 451; the claim or evidence listing no longer shows the text.
- Copies outside Pine (other IPFS nodes, the pinning provider) are not controlled by moderation: ask the pinning provider
  to remove the pin when the legal basis requires it, and record that the CID may persist elsewhere.
- Publish the takedown in the transparency report (launch gate: takedown, legal hold and transparency policy).
- An on-chain claim and its question cannot be removed; the market still resolves. Inform the adjudicators (Reality
  answerers, Kleros) through the claim creator when blocked evidence affects a running dispute.
