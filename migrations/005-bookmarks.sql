-- Bookmarks v2: the original table was posts-only (and never used — empty
-- in all environments). Rebuild it so a bookmark saves a post OR an
-- article, exactly one per row.
DROP TABLE IF EXISTS bookmarks;

CREATE TABLE bookmarks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  post_id    UUID REFERENCES posts(id) ON DELETE CASCADE,
  article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK ((post_id IS NULL) <> (article_id IS NULL))
);

CREATE UNIQUE INDEX bookmarks_user_post
  ON bookmarks (user_id, post_id) WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX bookmarks_user_article
  ON bookmarks (user_id, article_id) WHERE article_id IS NOT NULL;
