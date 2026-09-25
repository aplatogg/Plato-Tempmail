CREATE TABLE app_credentials (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  bootstrap_fingerprint TEXT NOT NULL,
  password_verifier TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0)
);

-- Revocation is part of the credential write, not a later request/transaction.
CREATE TRIGGER app_credentials_insert_revoke
AFTER INSERT ON app_credentials
BEGIN
  DELETE FROM sessions;
END;

CREATE TRIGGER app_credentials_update_revoke
AFTER UPDATE ON app_credentials
BEGIN
  DELETE FROM sessions;
END;
