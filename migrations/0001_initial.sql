CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  credential_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_rate_expiry ON rate_limits(expires_at);

CREATE TABLE inboxes (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  from_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  raw_digest TEXT NOT NULL,
  UNIQUE(inbox_id, raw_digest)
);
CREATE INDEX idx_message_page ON messages(inbox_id, received_at DESC, id DESC);
CREATE INDEX idx_message_expiry ON messages(expires_at);
