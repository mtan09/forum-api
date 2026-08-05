-- Article bodies are used transiently during ingestion and must not remain in
-- PostgreSQL. Persist only bounded, non-sequential features needed by
-- clustering, search, and recommendations.
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS analysis_profile JSONB;
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS analysis_text TEXT;
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS ai_context_allowed BOOLEAN NOT NULL DEFAULT FALSE;

-- Preserve search during the staged rollout: before the scrub job has derived
-- analysis_text for old rows, the old body remains a temporary fallback. Once
-- the scrub is complete, content is NULL and only title + derived terms remain.
DROP INDEX IF EXISTS idx_articles_tsv;
ALTER TABLE articles DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE articles ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      coalesce(title, '') || ' ' ||
      coalesce(analysis_text, left(coalesce(content, ''), 20000))
    )
  ) STORED;
CREATE INDEX idx_articles_tsv ON articles USING GIN (search_tsv);

CREATE INDEX IF NOT EXISTS idx_articles_ai_context_recent
  ON articles (published_at DESC) WHERE status = 'ready' AND ai_context_allowed;
