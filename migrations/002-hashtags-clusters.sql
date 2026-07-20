-- Hashtag system + auto-generated subtopic clusters.
-- Subtopics stop being hand-curated: the clustering job (src/ingest/cluster.ts)
-- generates them from recent articles + posts and upserts by cluster_key.
-- Idempotent; safe to re-run.

-- Hashtags: author-selected on posts, auto-extracted on articles
ALTER TABLE posts    ADD COLUMN IF NOT EXISTS hashtags TEXT[] DEFAULT '{}';
ALTER TABLE articles ADD COLUMN IF NOT EXISTS hashtags TEXT[] DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_posts_hashtags    ON posts    USING GIN (hashtags);
CREATE INDEX IF NOT EXISTS idx_articles_hashtags ON articles USING GIN (hashtags);

-- Cluster bookkeeping on subtopics
ALTER TABLE subtopics ADD COLUMN IF NOT EXISTS cluster_key TEXT UNIQUE;
ALTER TABLE subtopics ADD COLUMN IF NOT EXISTS score       FLOAT DEFAULT 0;
ALTER TABLE subtopics ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ DEFAULT NOW();

-- Clusters are regenerated; deleting a stale subtopic must not orphan-block
ALTER TABLE articles DROP CONSTRAINT IF EXISTS articles_subtopic_id_fkey;
ALTER TABLE articles ADD CONSTRAINT articles_subtopic_id_fkey
  FOREIGN KEY (subtopic_id) REFERENCES subtopics(id) ON DELETE SET NULL;
