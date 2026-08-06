-- Reposts are lightweight relationships to original content. Quote posts remain
-- ordinary authored posts and carry one typed reference to their source item.
CREATE TABLE IF NOT EXISTS reposts (
  user_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
  article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reposts_one_target CHECK (num_nonnulls(post_id, article_id) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS reposts_user_post
  ON reposts (user_id, post_id) WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reposts_user_article
  ON reposts (user_id, article_id) WHERE article_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reposts_post_recent
  ON reposts (post_id, created_at DESC) WHERE post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reposts_article_recent
  ON reposts (article_id, created_at DESC) WHERE article_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reposts_user_recent
  ON reposts (user_id, created_at DESC);

ALTER TABLE posts ADD COLUMN IF NOT EXISTS quoted_post_id UUID;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS quoted_article_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'posts_at_most_one_quote'
  ) THEN
    ALTER TABLE posts ADD CONSTRAINT posts_at_most_one_quote
      CHECK (num_nonnulls(quoted_post_id, quoted_article_id) <= 1);
  END IF;
END $$;

-- Quote references deliberately are not foreign keys. If the original is
-- deleted, the quoting user's commentary remains and the API returns an
-- unavailable-content tombstone instead of cascading someone else's post.
CREATE INDEX IF NOT EXISTS idx_posts_quoted_post
  ON posts (quoted_post_id) WHERE quoted_post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_quoted_article
  ON posts (quoted_article_id) WHERE quoted_article_id IS NOT NULL;
