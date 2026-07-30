-- Rights-aware, metadata-first article ingestion.
--
-- This migration is intentionally non-destructive: legacy article bodies and
-- media URLs remain stored until the separate cleanup command is reviewed.
-- Public routes and new ingestion stop using them immediately.

ALTER TABLE articles ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS entities TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE articles ADD COLUMN IF NOT EXISTS event_terms TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE articles ADD COLUMN IF NOT EXISTS search_text TEXT NOT NULL DEFAULT '';
ALTER TABLE articles ADD COLUMN IF NOT EXISTS text_mode TEXT NOT NULL DEFAULT 'headline_only'
  CHECK (text_mode IN ('headline_only', 'feed_description', 'full_text'));
ALTER TABLE articles ADD COLUMN IF NOT EXISTS image_mode TEXT NOT NULL DEFAULT 'none'
  CHECK (image_mode IN ('none', 'remote_no_cache', 'licensed_cache'));
ALTER TABLE articles ADD COLUMN IF NOT EXISTS ai_mode TEXT NOT NULL DEFAULT 'metadata_only'
  CHECK (ai_mode IN ('metadata_only', 'permitted_text', 'denied'));
ALTER TABLE articles ADD COLUMN IF NOT EXISTS rights_policy_version TEXT;

-- Existing rows are not grandfathered into broader rights merely because a
-- body or media URL was collected by the old pipeline.
UPDATE articles
SET text_mode = 'headline_only',
    image_mode = 'none',
    ai_mode = 'metadata_only',
    search_text = concat_ws(' ', title, source)
WHERE rights_policy_version IS NULL;

DROP INDEX IF EXISTS idx_articles_tsv;
ALTER TABLE articles DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE articles ADD COLUMN search_tsv TSVECTOR GENERATED ALWAYS AS
  (to_tsvector('english', coalesce(search_text, ''))) STORED;
CREATE INDEX idx_articles_tsv ON articles USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_articles_entities ON articles USING GIN (entities);
CREATE INDEX IF NOT EXISTS idx_articles_event_terms ON articles USING GIN (event_terms);

-- Old subtopic summaries may contain lifted body sentences. API routes hide
-- summaries without this version, and the next cluster run replaces them.
ALTER TABLE subtopics ADD COLUMN IF NOT EXISTS summary_policy_version TEXT;
