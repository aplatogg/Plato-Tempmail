-- API keys for automation clients (bots, bulk scripts).
-- The secret is shown once at creation; only its SHA-256 is stored. Each key is
-- bound to one principal and to the credential version current at mint time, so a
-- password change, a role change or a revoke retires the key without a session.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  credential_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX api_keys_user_idx ON api_keys(user_id);
CREATE INDEX api_keys_token_idx ON api_keys(token_hash);
