-- FROZEN. Core identity table every module may reference. The platform lane extends the schema in 0002+.
-- An account is a wallet (Sign-In with Ethereum). GitHub identities are linked to it by the platform.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Lowercase 0x-hex; the API displays EIP-55 checksummed form.
  wallet_address text NOT NULL UNIQUE CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
