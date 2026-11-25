CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL CHECK (id <> 'owner'),
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_verifier TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 1),
  created_at INTEGER NOT NULL
);

-- The owner is configured outside D1, so user_id deliberately has no users FK.
CREATE TABLE session_users (
  token_hash TEXT PRIMARY KEY NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  user_id TEXT NOT NULL
);
CREATE INDEX session_users_user ON session_users(user_id);

DROP TRIGGER app_credentials_insert_revoke;
DROP TRIGGER app_credentials_update_revoke;

-- Unmapped pre-migration sessions are owner-only; their version is still checked at read time.
CREATE TRIGGER app_credentials_insert_revoke
AFTER INSERT ON app_credentials
BEGIN
  DELETE FROM sessions WHERE token_hash NOT IN (SELECT token_hash FROM session_users)
    OR token_hash IN (SELECT token_hash FROM session_users WHERE user_id = 'owner');
END;

CREATE TRIGGER app_credentials_update_revoke
AFTER UPDATE ON app_credentials
BEGIN
  DELETE FROM sessions WHERE token_hash NOT IN (SELECT token_hash FROM session_users)
    OR token_hash IN (SELECT token_hash FROM session_users WHERE user_id = 'owner');
END;

CREATE TRIGGER users_credentials_revoke
AFTER UPDATE OF password_verifier, revision ON users
WHEN NEW.password_verifier IS NOT OLD.password_verifier OR NEW.revision IS NOT OLD.revision
BEGIN
  DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM session_users WHERE user_id = OLD.id);
END;
