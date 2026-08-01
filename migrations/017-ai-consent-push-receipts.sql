-- Explicit, versioned third-party AI permission and durable Expo push
-- receipts. Existing users are intentionally not grandfathered.

CREATE TABLE IF NOT EXISTS ai_data_consents (
  user_id TEXT PRIMARY KEY REFERENCES userdata(id) ON DELETE CASCADE,
  consent_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'declined', 'revoked')),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS push_receipts (
  ticket_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('replies', 'upvotes', 'dms', 'follows')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes',
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_receipts_due
  ON push_receipts (next_attempt_at);
