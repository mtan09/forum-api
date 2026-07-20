-- Comments get up/down votes, same pattern as posts and articles.
-- Idempotent; safe to re-run. Fresh installs get this from schema.sql.

ALTER TABLE comments ADD COLUMN IF NOT EXISTS upvotes   INTEGER DEFAULT 0;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS downvotes INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS comment_votes (
  user_id    TEXT REFERENCES userdata(id) ON DELETE CASCADE,
  comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL CHECK (direction IN ('up', 'down')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, comment_id)
);
CREATE INDEX IF NOT EXISTS idx_comment_votes_comment ON comment_votes(comment_id);
