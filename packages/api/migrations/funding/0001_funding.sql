-- Funding lane plan store (PRD-04 section 1): one row per transaction plan, keyed by (user, route, Idempotency-Key),
-- with a compare-and-set state machine planned -> submitted -> confirmed | failed | expired, and one row per step
-- holding the reported transaction hashes (speed-ups and replacements) and the step state.

CREATE TABLE funding_plans (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  route text NOT NULL CHECK (route ~ '^[a-z.]{1,64}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{1,64}$'),
  body_hash text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('ladder', 'withdraw', 'merge', 'redeem')),
  market text NOT NULL CHECK (market ~ '^0x[0-9a-f]{40}$'),
  account text NOT NULL CHECK (account ~ '^0x[0-9a-f]{40}$'),
  -- planToWire(plan): steps with their exact calldata; never contains secrets.
  wire jsonb NOT NULL,
  -- Disclosures and figures returned with the plan (decimal strings), returned unchanged on a same-key retry.
  details jsonb NOT NULL,
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned', 'submitted', 'confirmed', 'failed', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  reconciled_at timestamptz,
  UNIQUE (user_id, route, idempotency_key)
);

CREATE INDEX funding_plans_user_created ON funding_plans (user_id, created_at DESC, id DESC);
CREATE INDEX funding_plans_open ON funding_plans (reconciled_at NULLS FIRST, id) WHERE state IN ('planned', 'submitted');

CREATE TABLE funding_plan_steps (
  plan_id uuid NOT NULL REFERENCES funding_plans(id) ON DELETE CASCADE,
  step_id text NOT NULL CHECK (step_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  position integer NOT NULL CHECK (position >= 0 AND position < 16),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'confirmed')),
  tx_hashes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tx_hashes) <= 8),
  confirmed_tx_hash text CHECK (confirmed_tx_hash IS NULL OR confirmed_tx_hash ~ '^0x[0-9a-f]{64}$'),
  -- Redacted, fixed-vocabulary reason of the latest finalized failed attempt (never upstream text).
  revert_reason text CHECK (revert_reason IS NULL OR length(revert_reason) <= 200),
  PRIMARY KEY (plan_id, step_id),
  UNIQUE (plan_id, position),
  CHECK ((state = 'confirmed') = (confirmed_tx_hash IS NOT NULL))
);
