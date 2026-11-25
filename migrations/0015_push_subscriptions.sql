-- Web Push subscriptions. One row per browser/device a user enabled background
-- notifications from. The endpoint is unique: re-subscribing updates the keys.
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_success_at INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX push_subscriptions_user_idx ON push_subscriptions(user_id);
