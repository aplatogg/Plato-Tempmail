-- Sender display name, parsed from the From header at ingestion time.
-- Legacy rows keep NULL and the UI falls back to the address.
ALTER TABLE messages ADD COLUMN from_name TEXT;