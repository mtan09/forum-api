-- 008: launch-blocking moderation primitives — reports and blocks.
--
-- reports: any signed-in user can flag a post, article, comment, or user.
-- One live report per reporter per target (re-reporting updates it).
-- target_id is TEXT because user ids are TEXT while content ids are UUIDs.
--
-- blocks: one-directional. The blocker stops seeing the blocked user's
-- posts and comments everywhere; enforced in read queries, not triggers.

CREATE TABLE IF NOT EXISTS reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('post', 'article', 'comment', 'user')),
  target_id   TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('spam', 'harassment', 'misinformation', 'hate', 'other')),
  detail      TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (reporter_id, target_kind, target_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks(blocker_id);
