-- Add the lowest role, Rakyat Jelata (peasant), without changing existing masks.
-- The role is exclusive: mask 16 may not be combined with member/dev/admin/owner.
-- SQLite cannot alter a CHECK constraint, so rebuild users and restore its triggers.
CREATE TABLE users_new (
  id TEXT PRIMARY KEY NOT NULL CHECK (id <> 'owner'),
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_verifier TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 1),
  created_at INTEGER NOT NULL,
  role_mask INTEGER NOT NULL DEFAULT 1
    CHECK (
      typeof(role_mask) = 'integer'
      AND role_mask BETWEEN 1 AND 31
      AND ((role_mask & 16) = 0 OR role_mask = 16)
    )
);

INSERT INTO users_new (id, username, password_verifier, revision, created_at, role_mask)
SELECT id, username, password_verifier, revision, created_at, role_mask FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE TRIGGER users_roles_revoke
AFTER UPDATE OF role_mask ON users
WHEN NEW.role_mask IS NOT OLD.role_mask
BEGIN
  DELETE FROM sessions WHERE token_hash IN (
    SELECT token_hash FROM session_users WHERE user_id = OLD.id
  );
END;

CREATE TRIGGER users_credentials_revoke
AFTER UPDATE OF password_verifier, revision ON users
WHEN NEW.password_verifier IS NOT OLD.password_verifier OR NEW.revision IS NOT OLD.revision
BEGIN
  DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM session_users WHERE user_id = OLD.id);
END;
