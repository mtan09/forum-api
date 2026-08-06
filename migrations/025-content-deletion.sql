-- Exact-object cleanup for media belonging to individually deleted posts.
-- Account deletion continues to use prefix-scoped deletion_jobs.
CREATE TABLE IF NOT EXISTS media_deletion_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_media_deletion_jobs_due
  ON media_deletion_jobs (next_attempt_at)
  WHERE status IN ('pending', 'failed');
