-- Append-only record of privileged account actions.
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL,
  actor_username TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  target_username TEXT,
  detail TEXT,
  ip TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX audit_log_created ON audit_log(created_at);
CREATE INDEX audit_log_actor ON audit_log(actor_id);
