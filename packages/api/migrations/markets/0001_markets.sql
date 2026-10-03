-- markets lane: evidence uploads per user (idempotent quotas), the plan store (PRD-04 section 1), notifications and the
-- watch cursor. Cross-group foreign keys reference only the frozen users table. No salt, reveal calldata or file name
-- is ever stored here (SEC-EVID-08, PRD-04 section 2.2).

-- One row per (user, content digest) the user uploaded through Pine: a repeated upload of the same bytes is answered
-- from this row (no store call, no quota). Bytes live in the content store; only digest, CID, kind and size are recorded.
CREATE TABLE markets_uploads (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  sha256 text NOT NULL CHECK (sha256 ~ '^0x[0-9a-f]{64}$'),
  cid text NOT NULL CHECK (cid ~ '^b[a-z2-7]{1,100}$'),
  kind text NOT NULL CHECK (kind IN ('manifest', 'artifact')),
  size integer NOT NULL CHECK (size >= 0 AND size <= 262144),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, sha256)
);

CREATE TABLE markets_plans (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- Stable route name (e.g. "evidence.commit"); idempotency keys are scoped to (user, route).
  route text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{1,64}$'),
  body_hash text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL,
  market text CHECK (market IS NULL OR market ~ '^0x[0-9a-f]{40}$'),
  account text NOT NULL CHECK (account ~ '^0x[0-9a-f]{40}$'),
  -- planToWire output (calldata as the wallet will sign it) and the response details shown with it.
  wire jsonb NOT NULL,
  details jsonb NOT NULL,
  -- Read-model facts that confirm evidence commit/publish and submitAnswer steps (public values only).
  facts jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('planned', 'submitted', 'confirmed', 'failed', 'expired')),
  expires_at bigint NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  reconciled_at timestamptz,
  UNIQUE (user_id, route, idempotency_key)
);
CREATE INDEX markets_plans_open_idx ON markets_plans (reconciled_at NULLS FIRST, id) WHERE state IN ('planned', 'submitted');
CREATE INDEX markets_plans_user_idx ON markets_plans (user_id, created_at DESC, id);

CREATE TABLE markets_plan_steps (
  plan_id uuid NOT NULL REFERENCES markets_plans (id) ON DELETE RESTRICT,
  step_id text NOT NULL,
  ord integer NOT NULL CHECK (ord >= 0 AND ord < 16),
  allowlist_id text NOT NULL,
  to_address text NOT NULL CHECK (to_address ~ '^0x[0-9a-f]{40}$'),
  data text NOT NULL CHECK (data ~ '^0x([0-9a-f]{2})*$'),
  value numeric(78, 0) NOT NULL CHECK (value >= 0),
  state text NOT NULL CHECK (state IN ('pending', 'confirmed')),
  confirmed_by text,
  confirmed_at timestamptz,
  PRIMARY KEY (plan_id, step_id),
  UNIQUE (plan_id, ord)
);

-- Transaction hashes reported per step (hints: speed-ups and replacements add more).
CREATE TABLE markets_plan_txs (
  plan_id uuid NOT NULL,
  step_id text NOT NULL,
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('unknown', 'succeeded', 'reverted', 'mismatch')),
  -- Redacted, fixed-text reason (never upstream error text).
  reason text,
  reported_at timestamptz NOT NULL,
  checked_at timestamptz,
  PRIMARY KEY (plan_id, step_id, tx_hash),
  FOREIGN KEY (plan_id, step_id) REFERENCES markets_plan_steps (plan_id, step_id) ON DELETE RESTRICT
);

CREATE TABLE markets_notifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  market text NOT NULL CHECK (market ~ '^0x[0-9a-f]{40}$'),
  kind text NOT NULL,
  -- The block time / deadline the notification is about; (user, market, kind, target) is unique (idempotent job).
  target bigint NOT NULL,
  message text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  read_at timestamptz,
  UNIQUE (user_id, market, kind, target)
);
CREATE INDEX markets_notifications_user_idx ON markets_notifications (user_id, created_at DESC, id DESC);

-- Rotating cursor of markets.watch (single row).
CREATE TABLE markets_watch_state (
  id integer PRIMARY KEY CHECK (id = 1),
  cursor text,
  updated_at timestamptz NOT NULL
);
