-- platform-gateways: GitHub linking (SEC-GH-03/05/06/10), content store and pin outbox (SEC-EVID). Privileges for the API
-- role come from the platform group's default privileges; this group never names a role.

-- OAuth authorization requests: the state is stored only as its SHA-256, bound to the session and user, single use
-- (consumed with DELETE ... RETURNING), valid 10 minutes. The PKCE verifier is AES-256-GCM encrypted like tokens.
CREATE TABLE github_oauth_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 128),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verifier_key_id text NOT NULL,
  verifier_iv bytea NOT NULL CHECK (octet_length(verifier_iv) = 12),
  verifier_ciphertext bytea NOT NULL CHECK (octet_length(verifier_ciphertext) BETWEEN 17 AND 512),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX github_oauth_states_expires_idx ON github_oauth_states (expires_at);
CREATE INDEX github_oauth_states_session_idx ON github_oauth_states (session_id, created_at);

-- One row per Pine user. Identity is the numeric GitHub id; login is a display snapshot with its fetch time. A revoked
-- link keeps its row (identityOf ignores it) and does not count toward the one-GitHub-id-per-user rule.
CREATE TABLE github_links (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  github_user_id bigint NOT NULL CHECK (github_user_id > 0),
  login text NOT NULL CHECK (login ~ '^[A-Za-z0-9_-]{1,100}$'),
  login_fetched_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  revoked_reason text CHECK (revoked_reason IN ('unauthorized', 'decrypt_failed', 'refresh_rejected', 'webhook')),
  linked_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK ((status = 'active') = (revoked_at IS NULL))
);
CREATE UNIQUE INDEX github_links_github_user_live_idx ON github_links (github_user_id) WHERE status <> 'revoked';

-- Encrypted user tokens. AAD = pine:github:<user_id>:<kind>:<key_id>; plaintext never stored.
CREATE TABLE github_tokens (
  user_id uuid NOT NULL REFERENCES github_links(user_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
  key_id text NOT NULL CHECK (length(key_id) BETWEEN 1 AND 64),
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 4096),
  expires_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, kind)
);
CREATE INDEX github_tokens_key_idx ON github_tokens (key_id);

-- Content store: Postgres is the source of truth for objects of at most one raw IPFS block (262144 bytes).
CREATE TABLE content_blobs (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^0x[0-9a-f]{64}$'),
  size integer NOT NULL CHECK (size BETWEEN 0 AND 262144),
  cid text NOT NULL CHECK (cid ~ '^bafkrei[a-z2-7]{52}$'),
  declared_media_type text NOT NULL CHECK (length(declared_media_type) BETWEEN 1 AND 255),
  bytes bytea NOT NULL CHECK (octet_length(bytes) = size),
  created_at timestamptz NOT NULL
);

-- Pin outbox: one item per blob; each target is recorded as done separately so retries are idempotent.
CREATE TABLE content_pins (
  sha256 text PRIMARY KEY REFERENCES content_blobs(sha256) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'pinned', 'integrity_failed')),
  kubo_done boolean NOT NULL DEFAULT false,
  service_done boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL,
  last_error text CHECK (length(last_error) <= 500),
  updated_at timestamptz NOT NULL
);
CREATE INDEX content_pins_due_idx ON content_pins (next_attempt_at) WHERE status = 'pending';
