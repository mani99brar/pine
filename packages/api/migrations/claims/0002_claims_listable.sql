-- claims lane, claims-006: listing eligibility (PRD-03 §8a). Only fixed facts are stored; whether a claim's policy is
-- currently publishable is decided at query time from the catalog and the configuration, never stored.
-- parameters_valid: the document's policy parameters against the per-version schema, decided once at verification.
-- NULL means not computed yet (the integrity job fills it for verified rows, bounded per run).

ALTER TABLE claims_index ADD COLUMN parameters_valid boolean;

-- Listings and feeds: verified rows with valid parameters, newest first (the policy digest is filtered per query).
CREATE INDEX claims_index_listable_idx ON claims_index (created_block DESC, created_log_index DESC, policy_document_sha256)
  WHERE integrity_status = 'verified' AND parameters_valid;

-- Integrity job backfill: verified rows whose parameters have not been checked yet.
CREATE INDEX claims_index_parameters_backlog_idx ON claims_index (created_block, created_log_index)
  WHERE integrity_status = 'verified' AND parameters_valid IS NULL;
