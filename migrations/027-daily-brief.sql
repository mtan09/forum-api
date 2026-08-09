-- Persisted, timezone-aware Daily Brief editions. Delivery remains opt-in;
-- every signed-in user can generate the current edition on first open.

ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS push_daily_brief BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS email_daily_brief BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS timezone TEXT;

CREATE TABLE IF NOT EXISTS daily_briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  brief_date DATE NOT NULL,
  timezone TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_at TIMESTAMPTZ,
  emailed_at TIMESTAMPTZ,
  pushed_at TIMESTAMPTZ,
  email_attempts INTEGER NOT NULL DEFAULT 0,
  push_attempts INTEGER NOT NULL DEFAULT 0,
  last_delivery_error TEXT,
  UNIQUE (user_id, brief_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_briefs_user_recent
  ON daily_briefs (user_id, brief_date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_briefs_generated
  ON daily_briefs (generated_at DESC);

ALTER TABLE push_receipts DROP CONSTRAINT IF EXISTS push_receipts_kind_check;
ALTER TABLE push_receipts
  ADD CONSTRAINT push_receipts_kind_check
  CHECK (kind IN ('replies', 'upvotes', 'dms', 'follows', 'daily_brief'));
