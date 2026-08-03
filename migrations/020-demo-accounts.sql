-- Controlled release-demo personas are explicitly identifiable without
-- changing their stable usernames or deleting the content they authored.
ALTER TABLE userdata
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_userdata_demo
  ON userdata (is_demo) WHERE is_demo;

-- Content created by the temporary review scheduler is auditable and can be
-- distinguished from the older hand-seeded fixture corpus. The account-level
-- `is_demo` marker remains the user-facing disclosure.
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS is_demo_generated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS demo_job_id UUID;

ALTER TABLE comments
  ADD COLUMN IF NOT EXISTS is_demo_generated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE comments
  ADD COLUMN IF NOT EXISTS demo_job_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_demo_job
  ON posts (demo_job_id) WHERE demo_job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_demo_job
  ON comments (demo_job_id) WHERE demo_job_id IS NOT NULL;

-- Persistent character definitions keep each fictional account coherent from
-- one scheduler run to the next. The source-of-truth prose lives in
-- src/demo/personas.ts and is upserted before work is planned.
CREATE TABLE IF NOT EXISTS demo_personas (
  user_id       TEXT PRIMARY KEY REFERENCES userdata(id) ON DELETE CASCADE,
  lean          FLOAT NOT NULL CHECK (lean BETWEEN 0 AND 1),
  role          TEXT NOT NULL,
  voice         TEXT NOT NULL,
  interests     TEXT[] NOT NULL DEFAULT '{}',
  cadence_seed  INTEGER NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Work is planned ahead with stable, apparently irregular timestamps. A
-- unique dedupe key plus row locking makes every action idempotent across cron
-- retries and concurrent Railway workers.
CREATE TABLE IF NOT EXISTS demo_activity_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'post', 'post_comment', 'post_vote',
                    'debate_comment', 'debate_vote', 'comment_vote'
                  )),
  target_id       TEXT,
  payload         JSONB NOT NULL DEFAULT '{}',
  scheduled_for   TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'skipped', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  executed_at     TIMESTAMPTZ,
  dedupe_key      TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_demo_activity_due
  ON demo_activity_jobs (scheduled_for, id) WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_demo_activity_user
  ON demo_activity_jobs (user_id, scheduled_for DESC);
