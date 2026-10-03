-- Platform core schema (PRD-02 section 2): SIWE pre-sessions and nonces, sessions, terms acceptances, rate-limit windows,
-- quotas, the append-only audit log, moderation, job leases, and the runtime role `pine_api` with least-privilege grants.
-- Every timestamp except audit_log.created_at and job_leases is written by the application clock as a bound parameter.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pine_api') THEN
    CREATE ROLE pine_api NOLOGIN;
  END IF;
END
$$;

-- Anonymous pre-session bound to the __Host-pine_presession cookie (stored as SHA-256 hex of the cookie value).
CREATE TABLE siwe_presessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX siwe_presessions_expires_idx ON siwe_presessions (expires_at);

-- Single-use SIWE nonces (128-bit hex) with the exact message text that must be signed.
CREATE TABLE siwe_nonces (
  nonce text PRIMARY KEY CHECK (nonce ~ '^[0-9a-f]{32}$'),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  presession_id uuid NOT NULL REFERENCES siwe_presessions (id) ON DELETE CASCADE,
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  message text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX siwe_nonces_presession_idx ON siwe_nonces (presession_id);
CREATE INDEX siwe_nonces_expires_idx ON siwe_nonces (expires_at);

-- Sessions: only SHA-256 (hex) of the opaque pine_s1_ token is stored.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  terms_digest text NOT NULL CHECK (terms_digest ~ '^0x[0-9a-f]{64}$'),
  authenticated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_idle_expires_idx ON sessions (idle_expires_at);
CREATE INDEX sessions_absolute_expires_idx ON sessions (absolute_expires_at);

-- Terms and risk-disclosure acceptance records (SEC-LEGAL-03, SEC-AUTH-07): the signed SIWE message is the record.
CREATE TABLE terms_acceptances (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  terms_digest text NOT NULL CHECK (terms_digest ~ '^0x[0-9a-f]{64}$'),
  method text NOT NULL CHECK (method IN ('siwe')),
  message text NOT NULL,
  signature text NOT NULL,
  country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  accepted_at timestamptz NOT NULL
);
CREATE INDEX terms_acceptances_user_digest_idx ON terms_acceptances (user_id, terms_digest);

-- Fixed-window request counters keyed user:<id>, user:<id>:<route>, ip:<ip>:<route>, siwe:<address>.
CREATE TABLE rate_limit_windows (
  key text NOT NULL CHECK (length(key) <= 512),
  window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY (key, window_start)
);
CREATE INDEX rate_limit_windows_start_idx ON rate_limit_windows (window_start);

-- Fixed-window per-user quotas.
CREATE TABLE quota_usage (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  quota text NOT NULL,
  window_start timestamptz NOT NULL,
  used bigint NOT NULL CHECK (used >= 0),
  PRIMARY KEY (user_id, quota, window_start)
);
CREATE INDEX quota_usage_start_idx ON quota_usage (window_start);

-- Append-only audit log (SEC-OPS-07). The API role may only INSERT and SELECT; IPs are nulled after 30 days by
-- pine_audit_expire_ips(). No foreign key: audit rows outlive what they describe.
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
  subject_type text NOT NULL CHECK (length(subject_type) <= 64),
  subject_id text NOT NULL CHECK (length(subject_id) <= 256),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text CHECK (ip IS NULL OR length(ip) <= 64),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, created_at);

-- Moderation (SEC-OPS-06): hide or block with a reason; never edits documents or chain data.
CREATE TABLE moderation_states (
  subject text NOT NULL CHECK (subject IN ('claim', 'evidence', 'content', 'wallet', 'repository')),
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 256 AND subject_id = lower(subject_id)),
  action text NOT NULL CHECK (action IN ('hide', 'block')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  actor_user_id uuid,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (subject, subject_id)
);

-- Cross-process job exclusion (PRD-02 2.5): lease rows written with database time only.
CREATE TABLE job_leases (
  name text PRIMARY KEY,
  holder text NOT NULL,
  started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

-- Audit IP retention: the only path that modifies audit_log rows. Nulls `ip` on rows older than 30 days (database time).
CREATE FUNCTION pine_audit_expire_ips(max_rows integer) RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH expired AS (
    UPDATE audit_log SET ip = NULL
    WHERE id IN (
      SELECT id FROM audit_log
      WHERE ip IS NOT NULL AND created_at < now() - interval '30 days'
      ORDER BY id
      LIMIT greatest(1, least(coalesce(max_rows, 1000), 10000))
    )
    RETURNING 1
  )
  SELECT count(*)::integer FROM expired;
$$;
REVOKE EXECUTE ON FUNCTION pine_audit_expire_ips(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pine_audit_expire_ips(integer) TO pine_api;

-- Grants (PRD-02 2.5a): tables by name, never ON ALL TABLES.
GRANT USAGE ON SCHEMA public TO pine_api;
GRANT SELECT ON schema_migrations TO pine_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, siwe_presessions, siwe_nonces, sessions, terms_acceptances, rate_limit_windows,
  quota_usage, moderation_states, job_leases TO pine_api;
GRANT SELECT, INSERT ON audit_log TO pine_api;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq, terms_acceptances_id_seq, siwe_nonces_seq_seq TO pine_api;

-- Tables and sequences created later by the migrator role (gateways, claims, markets, funding groups).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pine_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pine_api;

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM pine_api;
