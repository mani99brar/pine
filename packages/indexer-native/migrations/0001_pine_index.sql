-- pine_index: the native indexer's read model (PRD-05 section 2.2). Append-only: never edit an applied file.
-- Every bigint-valued fact is int8 (blocks, unix seconds) or numeric(78,0) (uint256); untrusted on-chain strings are
-- stored JSON-encoded (text) so any byte sequence, including NUL, round-trips exactly.

CREATE SCHEMA IF NOT EXISTS pine_index;

-- One row per chain: the applied position, the last finalized/head observation and the strict-order guard.
CREATE TABLE pine_index.cursor (
  chain_id integer PRIMARY KEY,
  indexed_block int8 NOT NULL DEFAULT 0 CHECK (indexed_block >= 0),
  indexed_block_hash text,
  indexed_block_timestamp int8 NOT NULL DEFAULT 0 CHECK (indexed_block_timestamp >= 0),
  last_event_block int8,
  last_event_log_index integer,
  finalized_block int8,
  head_block int8,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((last_event_block IS NULL) = (last_event_log_index IS NULL))
);

-- Integrity halts (SEC-IDX-02/05/06): any row freezes the indexer for that chain until an operator removes it.
CREATE TABLE pine_index.halts (
  id bigserial PRIMARY KEY,
  chain_id integer NOT NULL,
  reason text NOT NULL CHECK (reason IN ('rpc_disagreement', 'log_disagreement', 'header_disagreement', 'log_hash_mismatch', 'decode_failure', 'finalized_conflict', 'invalid_rpc_data', 'apply_conflict')),
  detail text NOT NULL,
  block_number int8,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX halts_chain_idx ON pine_index.halts (chain_id);

-- Every applied log (tracked or ignored), recorded in the transaction that applied it: re-applying is a no-op (SEC-IDX-04).
CREATE TABLE pine_index.applied_events (
  chain_id integer NOT NULL,
  block_hash text NOT NULL,
  log_index integer NOT NULL CHECK (log_index >= 0),
  block_number int8 NOT NULL CHECK (block_number >= 0),
  PRIMARY KEY (chain_id, block_hash, log_index)
);

-- Canonical hashes of the blocks that contained applied events.
CREATE TABLE pine_index.blocks (
  chain_id integer NOT NULL,
  block_number int8 NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL,
  block_timestamp int8 NOT NULL CHECK (block_timestamp >= 0),
  PRIMARY KEY (chain_id, block_number)
);

CREATE TABLE pine_index.claims (
  market text PRIMARY KEY,
  registry text NOT NULL,
  creator text NOT NULL,
  claim_document_sha256 text NOT NULL,
  policy_document_sha256 text NOT NULL,
  repository_id int8 NOT NULL,
  commit text NOT NULL,
  question_id text NOT NULL,
  condition_id text NOT NULL,
  evidence_deadline int8 NOT NULL,
  reveal_deadline int8 NOT NULL,
  min_bond numeric(78, 0) NOT NULL,
  title_json text NOT NULL,
  market_name_json text NOT NULL,
  market_name_hash text NOT NULL,
  yes_token text NOT NULL,
  no_token text NOT NULL,
  invalid_token text NOT NULL,
  created_at int8 NOT NULL,
  created_block int8 NOT NULL,
  created_tx_hash text NOT NULL,
  created_log_index integer NOT NULL
);
CREATE INDEX claims_created_idx ON pine_index.claims (created_block DESC, created_log_index DESC);
CREATE INDEX claims_deadline_idx ON pine_index.claims (evidence_deadline, market COLLATE "C");
CREATE INDEX claims_creator_idx ON pine_index.claims (creator);
CREATE INDEX claims_document_idx ON pine_index.claims (claim_document_sha256);
CREATE INDEX claims_question_idx ON pine_index.claims (question_id);

CREATE TABLE pine_index.evidence (
  registry text NOT NULL,
  submission_id numeric(78, 0) NOT NULL,
  market text NOT NULL,
  submitter text NOT NULL,
  status text NOT NULL CHECK (status IN ('committed', 'revealed', 'published')),
  commitment text,
  content_sha256 text,
  committed_at int8 NOT NULL,
  revealed_at int8,
  committed_tx_hash text NOT NULL,
  committed_block int8 NOT NULL,
  committed_log_index integer NOT NULL,
  PRIMARY KEY (registry, submission_id)
);
CREATE INDEX evidence_order_idx ON pine_index.evidence (committed_block, committed_log_index);
CREATE INDEX evidence_market_idx ON pine_index.evidence (market);
CREATE INDEX evidence_submitter_idx ON pine_index.evidence (submitter);

-- Tracked Reality questions (every row is tracked).
CREATE TABLE pine_index.questions (
  question_id text PRIMARY KEY,
  opening_ts int8 NOT NULL,
  min_bond numeric(78, 0) NOT NULL,
  timeout int8 NOT NULL,
  best_answer text,
  bond numeric(78, 0) NOT NULL DEFAULT 0,
  finalize_ts int8 NOT NULL DEFAULT 0,
  pending_arbitration boolean NOT NULL DEFAULT false,
  arbitration_requested_by text,
  answered_by_arbitrator boolean NOT NULL DEFAULT false,
  bounty numeric(78, 0) NOT NULL DEFAULT 0,
  reopened_by text,
  reopens text,
  answer_count integer NOT NULL DEFAULT 0,
  last_event_block int8 NOT NULL DEFAULT 0
);

CREATE TABLE pine_index.question_markets (
  question_id text NOT NULL REFERENCES pine_index.questions (question_id),
  market text NOT NULL,
  PRIMARY KEY (question_id, market)
);

CREATE TABLE pine_index.answers (
  question_id text NOT NULL REFERENCES pine_index.questions (question_id),
  block_number int8 NOT NULL,
  log_index integer NOT NULL,
  answer text NOT NULL,
  history_hash text NOT NULL,
  answerer text NOT NULL,
  bond numeric(78, 0) NOT NULL,
  ts int8 NOT NULL,
  is_commitment boolean NOT NULL,
  revealed_answer text,
  tx_hash text NOT NULL,
  PRIMARY KEY (question_id, block_number, log_index)
);

CREATE TABLE pine_index.arbitrations (
  question_id text PRIMARY KEY REFERENCES pine_index.questions (question_id),
  stage text NOT NULL,
  requester text,
  rejection_reason_json text,
  arbitrator_answer text,
  updated_at int8 NOT NULL
);

CREATE TABLE pine_index.arbitration_history (
  question_id text NOT NULL REFERENCES pine_index.arbitrations (question_id),
  block_number int8 NOT NULL,
  log_index integer NOT NULL,
  stage text NOT NULL,
  at int8 NOT NULL,
  tx_hash text NOT NULL,
  PRIMARY KEY (question_id, block_number, log_index)
);

CREATE TABLE pine_index.tracked_conditions (
  condition_id text PRIMARY KEY
);

CREATE TABLE pine_index.condition_resolutions (
  condition_id text PRIMARY KEY REFERENCES pine_index.tracked_conditions (condition_id),
  ctf_question_id text NOT NULL,
  resolved_at int8 NOT NULL,
  tx_hash text NOT NULL,
  block_number int8 NOT NULL
);

CREATE TABLE pine_index.condition_payouts (
  condition_id text NOT NULL REFERENCES pine_index.condition_resolutions (condition_id),
  position integer NOT NULL CHECK (position >= 0),
  numerator numeric(78, 0) NOT NULL,
  PRIMARY KEY (condition_id, position)
);
