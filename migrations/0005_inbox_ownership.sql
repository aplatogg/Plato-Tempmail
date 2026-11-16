CREATE TABLE inbox_owners (
  inbox_id TEXT PRIMARY KEY REFERENCES inboxes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL
);
CREATE INDEX idx_inbox_owners_user ON inbox_owners(user_id);

-- Side tables preserve positional inbox/message INSERT compatibility.
INSERT INTO inbox_owners (inbox_id, user_id)
SELECT id, 'owner' FROM inboxes;

-- Deliberately independent of inbox/user lifetimes: an address cannot be recycled
-- by another principal after deletion, even when no messages remain.
CREATE TABLE address_claims (
  address TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);
INSERT INTO address_claims (address, user_id, claimed_at)
SELECT address, 'owner', created_at FROM inboxes;
