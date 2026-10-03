-- claims lane, claims-009 (PRD-03 §8c): reconciliation fetches receipts only for hints still 'unknown', at most 5 per
-- publication per run, least recently checked first (checked_at is set on every lookup).
-- 'unrelated': a successful receipt without the expected ClaimCreated log; final for that hash, never fetched again.
-- missing_at: time of the last lookup that found no receipt (cleared by a failed lookup). A hint the node did not know
-- after evidenceDeadline - 1 day can no longer create the claim, so it does not hold back expiry.

ALTER TABLE claim_publication_txs DROP CONSTRAINT claim_publication_txs_status_check;
ALTER TABLE claim_publication_txs ADD CONSTRAINT claim_publication_txs_status_check
  CHECK (status IN ('unknown', 'succeeded', 'reverted', 'unrelated'));
ALTER TABLE claim_publication_txs ADD COLUMN missing_at timestamptz;
