-- Daily debates: auto-picked from the published story clusters — the
-- biggest story of the day and the most contested one (covered heavily
-- by BOTH wings). Users drop a pin on the spectrum, then see the
-- community distribution and discuss in one shared thread.
CREATE TABLE IF NOT EXISTS debates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  debate_date DATE NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('biggest', 'contested')),
  subtopic_id UUID REFERENCES subtopics(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (debate_date, kind)
);

CREATE TABLE IF NOT EXISTS debate_votes (
  user_id    TEXT REFERENCES userdata(id) ON DELETE CASCADE,
  debate_id  UUID REFERENCES debates(id) ON DELETE CASCADE,
  position   FLOAT NOT NULL CHECK (position BETWEEN 0 AND 1),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, debate_id)
);

-- Comments can now also belong to a debate thread
ALTER TABLE comments ADD COLUMN IF NOT EXISTS debate_id UUID REFERENCES debates(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_comments_debate ON comments(debate_id) WHERE debate_id IS NOT NULL;
