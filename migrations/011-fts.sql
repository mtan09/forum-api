-- Full-text search: generated tsvector columns + GIN indexes so /search
-- stops doing sequential ILIKE scans over posts and articles.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;
CREATE INDEX IF NOT EXISTS idx_posts_tsv ON posts USING GIN (search_tsv);

ALTER TABLE articles ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || left(coalesce(content, ''), 20000))
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_articles_tsv ON articles USING GIN (search_tsv);
