# Incident response

Applies to any suspected security incident: leaked secret, account takeover, forged or tampered claim/evidence data,
integrity failures (pins, indexer `log_hash_mismatch`/`apply_conflict`), a vulnerability report in the contracts or the
API, abuse at scale, or legal emergencies.

## Roles

- **Incident lead** (on-call owner, named in the release checklist): coordinates, decides, writes the timeline.
- **Second person** for every destructive or irreversible action (deleting halts, blocking content, rotating keys).
- Legal contact for takedowns and regulatory questions; comms owner for user-facing notices.

## First hour

1. Declare the incident, open a private channel and a timeline (UTC times, who did what).
2. Contain without destroying evidence:
   - Stop plans: there is no on-chain pause (contracts have no admin). Stop the API from building plans by taking it out
     of the proxy (maintenance page) or by stopping `pine-api`; reads can stay up through a second instance if safe.
   - Leaked secret: rotate ([key-rotation.md](key-rotation.md)).
   - Abusive or illegal content: block it ([evidence-takedown.md](evidence-takedown.md)).
   - Compromised RPC or pin provider: replace it; keep the indexer halted until the data is understood.
3. Preserve: copy logs (`journalctl -u pine-api -u pine-indexer-native`), the relevant DB rows (`audit_log`,
   `pine_index.halts`, `content_pins`), and take a database snapshot before any repair.

## Investigation and recovery

- Audit trail: `audit_log` is append-only for the API (INSERT/SELECT only); IPs are kept 30 days.
- Chain facts are authoritative: anything the read model shows can be re-derived from finalized Gnosis logs (rebuild the
  index, [indexer-halt.md](indexer-halt.md)).
- Contract vulnerability reports follow the bug-bounty scope and disclosure policy (launch gate, SEC-SC-17); live
  vulnerabilities in third-party systems are never published by Pine (SC-001 stays disabled until a disclosure process
  is approved).
- Pine executes no submitted code: an incident never requires running a PoC on Pine infrastructure.

## Closing

Write a post-incident review within 5 working days: timeline, root cause, user impact, what was rotated or blocked, and
the follow-up changes (tracked as tickets). Notify affected users and authorities where the legal review requires it.
