-- Keep the original inbox/message column layout and positional INSERT compatibility.
-- Missing favorite/read rows mean false; those flags need no backfill.
CREATE TABLE inbox_favorites (
  inbox_id TEXT PRIMARY KEY NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1))
);

CREATE TABLE message_read_state (
  message_id TEXT PRIMARY KEY NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1))
);

-- AUTOINCREMENT preserves the arrival high-water mark after deletion of the largest row.
-- Store only metadata, not a second copy of message content.
CREATE TABLE message_arrivals (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE
);

INSERT INTO message_arrivals (message_id)
SELECT id FROM messages ORDER BY received_at ASC, id ASC;

-- AFTER INSERT runs only for inserted messages, never for ignored raw_digest duplicates.
CREATE TRIGGER record_message_arrival AFTER INSERT ON messages
BEGIN
  INSERT INTO message_arrivals (message_id) VALUES (NEW.id);
END;
