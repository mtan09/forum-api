-- Transient article analysis, structured evidence, and managed thumbnails.
--
-- Raw publisher text is never inserted by this migration. article_evidence
-- contains compact, non-reconstructive analysis plus a one-way source hash.

ALTER TABLE articles DROP CONSTRAINT IF EXISTS articles_image_mode_check;
ALTER TABLE articles ADD CONSTRAINT articles_image_mode_check
  CHECK (image_mode IN ('none', 'remote_no_cache', 'managed_thumbnail', 'licensed_cache'));

ALTER TABLE articles DROP CONSTRAINT IF EXISTS articles_ai_mode_check;
ALTER TABLE articles ADD CONSTRAINT articles_ai_mode_check
  CHECK (ai_mode IN ('metadata_only', 'structured_evidence', 'permitted_text', 'denied'));

ALTER TABLE articles ADD COLUMN IF NOT EXISTS media_source_url TEXT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS media_thumbnail_url TEXT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS media_large_url TEXT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS media_width INTEGER;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS media_height INTEGER;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS media_status TEXT NOT NULL DEFAULT 'none'
  CHECK (media_status IN ('none', 'pending', 'ready', 'failed'));
ALTER TABLE articles ADD COLUMN IF NOT EXISTS media_source_hash TEXT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS media_cached_at TIMESTAMPTZ;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS media_expires_at TIMESTAMPTZ;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS media_error TEXT;

CREATE TABLE IF NOT EXISTS article_evidence (
  article_id UUID PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  extraction_version TEXT NOT NULL,
  source_text_hash TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  evidence_summary TEXT NOT NULL DEFAULT '',
  claims JSONB NOT NULL DEFAULT '[]'::jsonb,
  timeline JSONB NOT NULL DEFAULT '[]'::jsonb,
  relationships JSONB NOT NULL DEFAULT '[]'::jsonb,
  disputed_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  entities TEXT[] NOT NULL DEFAULT '{}',
  event_terms TEXT[] NOT NULL DEFAULT '{}',
  search_text TEXT NOT NULL DEFAULT '',
  extraction_method TEXT NOT NULL
    CHECK (extraction_method IN ('metadata', 'feed', 'full_page')),
  confidence FLOAT NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  generated_by TEXT NOT NULL DEFAULT 'deterministic'
    CHECK (generated_by IN ('deterministic', 'openai')),
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_article_evidence_search
  ON article_evidence USING GIN (to_tsvector('english', search_text));
CREATE INDEX IF NOT EXISTS idx_article_evidence_entities
  ON article_evidence USING GIN (entities);
CREATE INDEX IF NOT EXISTS idx_article_evidence_event_terms
  ON article_evidence USING GIN (event_terms);

CREATE TABLE IF NOT EXISTS article_analysis_usage (
  day DATE PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS evidence_generated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS evidence_fallback INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS images_cached INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS images_fallback INTEGER NOT NULL DEFAULT 0;
