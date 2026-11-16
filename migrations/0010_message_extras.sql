-- Message HTML (raw, sanitized in the client sandbox) and attachment metadata.
ALTER TABLE messages ADD COLUMN html TEXT;
ALTER TABLE messages ADD COLUMN attachments TEXT;
-- Per-inbox webhook forwarding target.
ALTER TABLE inboxes ADD COLUMN webhook_url TEXT;
