-- Adds scorer bookkeeping columns for the deterministic bias scorer.
-- Idempotent; safe to re-run. Fresh installs get these from schema.sql.

ALTER TABLE articles ADD COLUMN IF NOT EXISTS source_lean    FLOAT CHECK (source_lean BETWEEN 0 AND 1);
ALTER TABLE articles ADD COLUMN IF NOT EXISTS scorer_version TEXT;

ALTER TABLE posts ADD COLUMN IF NOT EXISTS position_confidence FLOAT CHECK (position_confidence BETWEEN 0 AND 1);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS position_signals    TEXT[] DEFAULT '{}';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS scorer_version      TEXT;
