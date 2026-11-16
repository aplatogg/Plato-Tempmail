-- One-time, short-lived password reset tokens. Only the SHA-256 of the token is stored.
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > created_at),
  used_at INTEGER
);

CREATE INDEX password_resets_user ON password_resets(user_id);
CREATE INDEX password_resets_expiry ON password_resets(expires_at);
