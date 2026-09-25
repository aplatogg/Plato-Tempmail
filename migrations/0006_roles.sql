ALTER TABLE users ADD COLUMN role_mask INTEGER NOT NULL DEFAULT 1
  CHECK (typeof(role_mask) = 'integer' AND role_mask BETWEEN 1 AND 15);

-- Role-only SQL edits must revoke sessions too, even without a revision update.
-- The API also increments revision, making every role edit an identity change.
CREATE TRIGGER users_roles_revoke
AFTER UPDATE OF role_mask ON users
WHEN NEW.role_mask IS NOT OLD.role_mask
BEGIN
  DELETE FROM sessions WHERE token_hash IN (
    SELECT token_hash FROM session_users WHERE user_id = OLD.id
  );
END;
