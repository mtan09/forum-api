-- TestFlight release hardening: private accounts, channel-specific
-- notifications, pre-publication moderation audits, structured feedback,
-- durable media cleanup, and observable ingestion runs.

ALTER TABLE userdata
  ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE follows
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('pending', 'accepted'));
ALTER TABLE follows
  ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ;
UPDATE follows SET status = 'accepted' WHERE status IS NULL;
CREATE INDEX IF NOT EXISTS idx_follows_pending
  ON follows (followee_id, created_at DESC) WHERE status = 'pending';

ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS push_replies BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS push_upvotes BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS push_dms BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS push_follows BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS email_replies BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS email_upvotes BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS email_dms BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS email_follows BOOLEAN NOT NULL DEFAULT FALSE;

-- Preserve the meaning of preferences saved by older app versions.
UPDATE notification_prefs
SET push_replies = replies,
    push_upvotes = upvotes,
    push_dms = dms;

CREATE TABLE IF NOT EXISTS moderation_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT REFERENCES userdata(id) ON DELETE SET NULL,
  surface TEXT NOT NULL CHECK (
    surface IN ('post', 'comment', 'dm', 'username', 'bio', 'forumai_prompt', 'image')
  ),
  input_hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'reject', 'review', 'unavailable')),
  provider TEXT NOT NULL,
  model TEXT,
  categories TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  target_kind TEXT,
  target_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_moderation_audits_review
  ON moderation_audits (decision, created_at DESC);

CREATE TABLE IF NOT EXISTS beta_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT REFERENCES userdata(id) ON DELETE SET NULL,
  category TEXT NOT NULL CHECK (
    category IN ('bug', 'ui', 'performance', 'content', 'idea', 'other')
  ),
  message TEXT NOT NULL,
  screenshot_key TEXT,
  route TEXT,
  theme TEXT,
  app_version TEXT,
  build_number TEXT,
  platform TEXT,
  os_version TEXT,
  device_model TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'planned', 'resolved', 'dismissed')),
  admin_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_beta_feedback_status
  ON beta_feedback (status, created_at DESC);

CREATE TABLE IF NOT EXISTS deletion_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deleted_user_id TEXT NOT NULL,
  public_prefix TEXT NOT NULL,
  feedback_prefix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_deletion_jobs_due
  ON deletion_jobs (next_attempt_at) WHERE status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS notification_email_digests (
  user_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  upvote_count INTEGER NOT NULL DEFAULT 1,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_email_digests_due
  ON notification_email_digests (scheduled_for);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'partial', 'failed', 'skipped_locked')),
  feeds_ok INTEGER NOT NULL DEFAULT 0,
  feeds_failed INTEGER NOT NULL DEFAULT 0,
  sources_failed TEXT[] NOT NULL DEFAULT '{}',
  seen INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  skipped_duplicate INTEGER NOT NULL DEFAULT 0,
  skipped_irrelevant INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_started
  ON ingest_runs (started_at DESC);

-- The published demo identity keeps its authored content, but its documented
-- password and admin access must not survive this production migration.
UPDATE userdata
SET is_admin = FALSE
WHERE id IN (
  SELECT user_id FROM auth_credentials WHERE lower(email) = 'john@example.dev'
);
DELETE FROM auth_credentials WHERE lower(email) = 'john@example.dev';
