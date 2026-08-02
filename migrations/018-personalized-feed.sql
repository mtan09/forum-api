-- First-party recommendation data. Vectors are generated locally by forum;
-- no behavioral profile or user content is sent to an embedding provider.

CREATE TABLE IF NOT EXISTS user_interests (
  user_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  interest_key TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1 CHECK (weight > 0 AND weight <= 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, interest_key)
);

CREATE TABLE IF NOT EXISTS feed_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  feed_mode TEXT NOT NULL CHECK (feed_mode IN ('for_you', 'random', 'against')),
  item_type TEXT NOT NULL CHECK (item_type IN ('post', 'article')),
  item_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('impression', 'dwell', 'open', 'outbound_open', 'not_interested')
  ),
  position INTEGER CHECK (position IS NULL OR position >= 0),
  dwell_ms INTEGER CHECK (dwell_ms IS NULL OR dwell_ms >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feed_events_user_recent
  ON feed_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_events_item_recent
  ON feed_events (item_type, item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_events_session
  ON feed_events (user_id, session_id, created_at);

CREATE TABLE IF NOT EXISTS content_preferences (
  user_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('post', 'article')),
  item_id UUID NOT NULL,
  preference TEXT NOT NULL CHECK (preference IN ('not_interested')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, item_type, item_id)
);
CREATE INDEX IF NOT EXISTS idx_content_preferences_user
  ON content_preferences (user_id, created_at DESC);

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS recommendation_embedding REAL[];
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS recommendation_embedding REAL[];
