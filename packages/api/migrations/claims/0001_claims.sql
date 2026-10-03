-- claims lane: drafts, immutable previews, publication state machine and the claim listing index.
-- Cross-group foreign keys reference only the frozen users table. Nothing cascades: previews are deleted explicitly
-- with their draft, and a draft with a publication cannot be deleted (RESTRICT).

CREATE TABLE claim_drafts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision >= 1),
  input jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX claim_drafts_user_idx ON claim_drafts (user_id, created_at DESC, id);

-- Immutable once written: the exact canonical bytes of the claim document and what was shown with it.
CREATE TABLE claim_previews (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  draft_id uuid NOT NULL REFERENCES claim_drafts (id) ON DELETE RESTRICT,
  draft_revision integer NOT NULL,
  document bytea NOT NULL CHECK (octet_length(document) <= 262144),
  document_sha256 text NOT NULL UNIQUE CHECK (document_sha256 ~ '^0x[0-9a-f]{64}$'),
  document_cid text NOT NULL,
  creator text NOT NULL CHECK (creator ~ '^0x[0-9a-f]{40}$'),
  question text NOT NULL,
  policy_id text NOT NULL,
  policy_version text NOT NULL,
  evidence_deadline bigint NOT NULL,
  reveal_deadline bigint NOT NULL,
  plan_expires_at bigint NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX claim_previews_draft_idx ON claim_previews (draft_id);

CREATE TABLE claim_publications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  preview_id uuid NOT NULL REFERENCES claim_previews (id) ON DELETE RESTRICT,
  draft_id uuid NOT NULL REFERENCES claim_drafts (id) ON DELETE RESTRICT,
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^0x[0-9a-f]{64}$'),
  creator text NOT NULL CHECK (creator ~ '^0x[0-9a-f]{40}$'),
  plan_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('planned', 'submitted', 'mined', 'confirmed', 'failed', 'expired')),
  market text CHECK (market IS NULL OR market ~ '^0x[0-9a-f]{40}$'),
  evidence_deadline bigint NOT NULL,
  plan_expires_at bigint NOT NULL,
  failure_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- Last reconciliation attempt; the job takes the least recently checked rows first so none starves.
  reconciled_at timestamptz,
  UNIQUE (user_id, document_sha256)
);
CREATE INDEX claim_publications_open_idx ON claim_publications (reconciled_at NULLS FIRST, id) WHERE state IN ('planned', 'submitted', 'mined');
CREATE INDEX claim_publications_draft_idx ON claim_publications (draft_id);

-- Transaction hashes reported by the user (hints only; speed-ups and replacements add more).
CREATE TABLE claim_publication_txs (
  publication_id uuid NOT NULL REFERENCES claim_publications (id) ON DELETE RESTRICT,
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('unknown', 'succeeded', 'reverted')),
  reason text,
  reported_at timestamptz NOT NULL,
  checked_at timestamptz,
  PRIMARY KEY (publication_id, tx_hash)
);

-- Listing index written by claims.verify-integrity: the only source of public listings and agent feeds.
-- No moderation data (moderation is applied at read time).
CREATE TABLE claims_index (
  market text PRIMARY KEY CHECK (market ~ '^0x[0-9a-f]{40}$'),
  registry text NOT NULL,
  creator text NOT NULL,
  claim_document_sha256 text NOT NULL,
  policy_document_sha256 text NOT NULL,
  policy_id text,
  -- uint64 on-chain (a direct contract call can use any value): unbounded numeric, read as text.
  repository_id numeric NOT NULL CHECK (repository_id >= 0),
  evidence_deadline bigint NOT NULL,
  reveal_deadline bigint NOT NULL,
  created_block bigint NOT NULL,
  created_log_index integer NOT NULL,
  integrity_status text NOT NULL CHECK (integrity_status IN ('pending', 'verified', 'mismatch', 'document_unavailable')),
  mismatch_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  final boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  first_unavailable_at timestamptz,
  last_error text,
  discovered_at timestamptz NOT NULL,
  checked_at timestamptz
);
CREATE INDEX claims_index_listing_idx ON claims_index (created_block DESC, created_log_index DESC) WHERE integrity_status = 'verified';
CREATE INDEX claims_index_work_idx ON claims_index (next_attempt_at, created_block, created_log_index) WHERE NOT final;
CREATE INDEX claims_index_repository_idx ON claims_index (repository_id, created_block DESC, created_log_index DESC);
CREATE INDEX claims_index_creator_idx ON claims_index (creator, created_block DESC, created_log_index DESC);
