-- Admin moderation: reviewer role, ban flag, hideable content, and report
-- lifecycle so the UGC report pipeline is actionable, not write-only.
ALTER TABLE userdata ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE userdata ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE posts    ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE reports ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'
  CHECK (status IN ('open', 'resolved', 'dismissed'));
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_by TEXT REFERENCES userdata(id);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status, created_at DESC);
