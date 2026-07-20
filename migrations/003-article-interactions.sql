-- Articles get the same interactions as posts: votes and comments.
-- Idempotent; safe to re-run. Fresh installs get this from schema.sql.

ALTER TABLE articles ADD COLUMN IF NOT EXISTS upvotes      INTEGER DEFAULT 0;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS downvotes    INTEGER DEFAULT 0;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS commentcount INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS article_votes (
  user_id    TEXT REFERENCES userdata(id) ON DELETE CASCADE,
  article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL CHECK (direction IN ('up', 'down')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, article_id)
);
CREATE INDEX IF NOT EXISTS idx_article_votes_article ON article_votes(article_id);

-- A comment belongs to either a post or an article (replies inherit both
-- from their parent, so they stay consistent)
ALTER TABLE comments ADD COLUMN IF NOT EXISTS article_id UUID REFERENCES articles(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_comments_article ON comments(article_id);
