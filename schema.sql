-- ============================================================
-- forum schema — works on any Postgres 13+ (local, Neon, ...)
-- gen_random_uuid() is built into Postgres 13+, no extension needed
-- ============================================================

CREATE TABLE IF NOT EXISTS userdata (
  id          TEXT PRIMARY KEY,        -- app-generated UUID string
  username    TEXT NOT NULL UNIQUE,
  avatar_url  TEXT,
  bio         TEXT,
  header_url  TEXT,
  is_admin    BOOLEAN NOT NULL DEFAULT FALSE,
  is_banned   BOOLEAN NOT NULL DEFAULT FALSE,
  is_private  BOOLEAN NOT NULL DEFAULT FALSE,
  is_demo     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Email/password credentials, separate from public profile data.
-- Emails are stored lowercased by the API.
CREATE TABLE IF NOT EXISTS auth_credentials (
  user_id       TEXT PRIMARY KEY REFERENCES userdata(id) ON DELETE CASCADE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS general_topics (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        TEXT NOT NULL,
  slug                        TEXT NOT NULL UNIQUE,
  spectrum_left_label         TEXT,
  spectrum_right_label        TEXT,
  spectrum_left_description   TEXT,
  spectrum_right_description  TEXT,
  importance                  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subtopics (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  general_topic_id  UUID REFERENCES general_topics(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  short_summary     TEXT,
  long_summary      TEXT,
  keywords          TEXT[] DEFAULT '{}',
  volume            INTEGER DEFAULT 0,
  public_position   FLOAT CHECK (public_position BETWEEN 0 AND 1),
  image_urls        TEXT[] DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS posts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             TEXT REFERENCES userdata(id) ON DELETE CASCADE,
  content             TEXT,
  media_url           TEXT,
  general_topic_id    UUID REFERENCES general_topics(id),
  -- position is set by the scorer at creation; NULL = no directional
  -- evidence, so the app shows no spectrum placement (see src/scoring/)
  position            FLOAT CHECK (position BETWEEN 0 AND 1),
  position_confidence FLOAT CHECK (position_confidence BETWEEN 0 AND 1),
  position_signals    TEXT[] DEFAULT '{}',
  scorer_version      TEXT,
  is_demo_generated   BOOLEAN NOT NULL DEFAULT FALSE,
  demo_job_id         UUID,
  upvotes             INTEGER DEFAULT 0,
  downvotes           INTEGER DEFAULT 0,
  commentcount        INTEGER DEFAULT 0,
  hidden              BOOLEAN NOT NULL DEFAULT FALSE,
  search_tsv          TSVECTOR GENERATED ALWAYS AS
                        (to_tsvector('english', coalesce(content, ''))) STORED,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS articles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url                 TEXT UNIQUE NOT NULL,
  content_hash        TEXT UNIQUE,
  title               TEXT,
  source              TEXT,
  -- Article text is transient analysis input and is never persisted. Keep the
  -- legacy nullable column temporarily so old databases can migrate safely.
  content             TEXT CHECK (content IS NULL),
  analysis_profile    JSONB,
  analysis_text       TEXT,
  ai_context_allowed  BOOLEAN NOT NULL DEFAULT FALSE,
  media               TEXT,
  political_lean      FLOAT CHECK (political_lean BETWEEN 0 AND 1),
  political_relevance FLOAT CHECK (political_relevance BETWEEN 0 AND 1),
  lean_confidence     FLOAT CHECK (lean_confidence BETWEEN 0 AND 1),
  content_type        TEXT CHECK (content_type IN ('news_report', 'opinion', 'analysis', 'factual_report')),
  lean_signals        TEXT[] DEFAULT '{}',
  source_lean         FLOAT CHECK (source_lean BETWEEN 0 AND 1),
  scorer_version      TEXT,
  upvotes             INTEGER DEFAULT 0,
  downvotes           INTEGER DEFAULT 0,
  commentcount        INTEGER DEFAULT 0,
  general_topic_id    UUID REFERENCES general_topics(id),
  subtopic_id         UUID REFERENCES subtopics(id),
  published_at        TIMESTAMPTZ,
  status              TEXT DEFAULT 'ready' CHECK (status IN ('pending', 'ready')),
  search_tsv          TSVECTOR GENERATED ALWAYS AS
                        (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(analysis_text, ''))) STORED,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Daily debates auto-picked from published story clusters: the biggest
-- story and the most contested one. Users pin a position, then see the
-- community distribution and discuss in a shared thread.
CREATE TABLE IF NOT EXISTS debates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  debate_date DATE NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('biggest', 'contested', 'trending')),
  subtopic_id UUID REFERENCES subtopics(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (debate_date, subtopic_id)
);

CREATE TABLE IF NOT EXISTS debate_votes (
  user_id    TEXT REFERENCES userdata(id) ON DELETE CASCADE,
  debate_id  UUID REFERENCES debates(id) ON DELETE CASCADE,
  position   FLOAT NOT NULL CHECK (position BETWEEN 0 AND 1),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, debate_id)
);

-- A comment belongs to a post, an article, or a debate thread
CREATE TABLE IF NOT EXISTS comments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           TEXT REFERENCES userdata(id) ON DELETE CASCADE,
  post_id           UUID REFERENCES posts(id) ON DELETE CASCADE,
  article_id        UUID REFERENCES articles(id) ON DELETE CASCADE,
  debate_id         UUID REFERENCES debates(id) ON DELETE CASCADE,
  parent_comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
  content           TEXT NOT NULL,
  is_demo_generated BOOLEAN NOT NULL DEFAULT FALSE,
  demo_job_id       UUID,
  upvotes           INTEGER DEFAULT 0,
  downvotes         INTEGER DEFAULT 0,
  hidden            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS votes (
  user_id    TEXT REFERENCES userdata(id) ON DELETE CASCADE,
  post_id    UUID REFERENCES posts(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL CHECK (direction IN ('up', 'down')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS article_votes (
  user_id    TEXT REFERENCES userdata(id) ON DELETE CASCADE,
  article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL CHECK (direction IN ('up', 'down')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, article_id)
);

CREATE TABLE IF NOT EXISTS comment_votes (
  user_id    TEXT REFERENCES userdata(id) ON DELETE CASCADE,
  comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL CHECK (direction IN ('up', 'down')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, comment_id)
);
CREATE INDEX IF NOT EXISTS idx_comment_votes_comment ON comment_votes(comment_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_demo_job
  ON posts (demo_job_id) WHERE demo_job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_demo_job
  ON comments (demo_job_id) WHERE demo_job_id IS NOT NULL;

-- Temporary, visibly labeled App Review community fixtures. These tables are
-- inert unless DEMO_ACTIVITY_ENABLED=yes is set on the dedicated worker.
CREATE TABLE IF NOT EXISTS demo_personas (
  user_id       TEXT PRIMARY KEY REFERENCES userdata(id) ON DELETE CASCADE,
  lean          FLOAT NOT NULL CHECK (lean BETWEEN 0 AND 1),
  role          TEXT NOT NULL,
  voice         TEXT NOT NULL,
  interests     TEXT[] NOT NULL DEFAULT '{}',
  cadence_seed  INTEGER NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS demo_activity_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
                  kind            TEXT NOT NULL CHECK (kind IN (
                    'post', 'post_comment', 'post_vote',
                    'article_comment', 'article_vote',
                    'debate_comment', 'debate_vote', 'comment_vote'
                  )),
  target_id       TEXT,
  payload         JSONB NOT NULL DEFAULT '{}',
  scheduled_for   TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'skipped', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  executed_at     TIMESTAMPTZ,
  dedupe_key      TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_demo_activity_due
  ON demo_activity_jobs (scheduled_for, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_demo_activity_user
  ON demo_activity_jobs (user_id, scheduled_for DESC);

-- A bookmark saves a post OR an article — exactly one per row
CREATE TABLE IF NOT EXISTS bookmarks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  post_id    UUID REFERENCES posts(id) ON DELETE CASCADE,
  article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK ((post_id IS NULL) <> (article_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS bookmarks_user_post
  ON bookmarks (user_id, post_id) WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bookmarks_user_article
  ON bookmarks (user_id, article_id) WHERE article_id IS NOT NULL;

-- Moderation: reports (one live report per reporter per target) and
-- one-directional blocks (enforced in read queries, not triggers)
CREATE TABLE IF NOT EXISTS reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('post', 'article', 'comment', 'user', 'message')),
  target_id   TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('spam', 'harassment', 'misinformation', 'hate', 'other')),
  detail      TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_by TEXT REFERENCES userdata(id),
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (reporter_id, target_kind, target_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks(blocker_id);

CREATE TABLE IF NOT EXISTS user_positions (
  user_id    TEXT REFERENCES userdata(id) ON DELETE CASCADE,
  topic_id   UUID REFERENCES general_topics(id) ON DELETE CASCADE,
  position   FLOAT NOT NULL CHECK (position BETWEEN 0 AND 1),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, topic_id)
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('pending', 'accepted')),
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows (followee_id);
CREATE INDEX IF NOT EXISTS idx_follows_pending
  ON follows (followee_id, created_at DESC) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  a_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  b_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (a_id < b_id),
  UNIQUE (a_id, b_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_a ON conversations (a_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_b ON conversations (b_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  shared_post_id UUID REFERENCES posts(id) ON DELETE SET NULL,
  shared_article_id UUID REFERENCES articles(id) ON DELETE SET NULL,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT messages_one_shared_item CHECK (
    num_nonnulls(shared_post_id, shared_article_id) <= 1
  )
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_shared_post
  ON messages (shared_post_id) WHERE shared_post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_shared_article
  ON messages (shared_article_id) WHERE shared_article_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_reads (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS push_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  platform TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens (user_id);

CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id TEXT PRIMARY KEY REFERENCES userdata(id) ON DELETE CASCADE,
  push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  replies BOOLEAN NOT NULL DEFAULT TRUE,
  upvotes BOOLEAN NOT NULL DEFAULT TRUE,
  dms BOOLEAN NOT NULL DEFAULT TRUE,
  push_replies BOOLEAN NOT NULL DEFAULT TRUE,
  push_upvotes BOOLEAN NOT NULL DEFAULT TRUE,
  push_dms BOOLEAN NOT NULL DEFAULT TRUE,
  push_follows BOOLEAN NOT NULL DEFAULT TRUE,
  email_replies BOOLEAN NOT NULL DEFAULT TRUE,
  email_upvotes BOOLEAN NOT NULL DEFAULT FALSE,
  email_dms BOOLEAN NOT NULL DEFAULT TRUE,
  email_follows BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS moderation_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT REFERENCES userdata(id) ON DELETE SET NULL,
  surface TEXT NOT NULL CHECK (
    surface IN ('post', 'comment', 'dm', 'username', 'bio', 'forumai_prompt', 'image')
  ),
  input_hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'reject', 'review', 'unavailable')),
  provider TEXT NOT NULL,
  model TEXT,
  categories TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  target_kind TEXT,
  target_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_moderation_audits_review
  ON moderation_audits (decision, created_at DESC);

CREATE TABLE IF NOT EXISTS beta_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT REFERENCES userdata(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (
    category IN ('bug', 'ui', 'performance', 'content', 'idea', 'other')
  ),
  message TEXT NOT NULL,
  screenshot_key TEXT,
  route TEXT,
  theme TEXT,
  app_version TEXT,
  build_number TEXT,
  platform TEXT,
  os_version TEXT,
  device_model TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'planned', 'resolved', 'dismissed')),
  admin_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_beta_feedback_status
  ON beta_feedback (status, created_at DESC);

CREATE TABLE IF NOT EXISTS deletion_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deleted_user_id TEXT NOT NULL,
  public_prefix TEXT NOT NULL,
  feedback_prefix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_deletion_jobs_due
  ON deletion_jobs (next_attempt_at) WHERE status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS media_deletion_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_media_deletion_jobs_due
  ON media_deletion_jobs (next_attempt_at) WHERE status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS notification_email_digests (
  user_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  upvote_count INTEGER NOT NULL DEFAULT 1,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_email_digests_due
  ON notification_email_digests (scheduled_for);

CREATE TABLE IF NOT EXISTS ai_data_consents (
  user_id TEXT PRIMARY KEY REFERENCES userdata(id) ON DELETE CASCADE,
  consent_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'declined', 'revoked')),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS push_receipts (
  ticket_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('replies', 'upvotes', 'dms', 'follows')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes',
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_receipts_due
  ON push_receipts (next_attempt_at);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'partial', 'failed', 'skipped_locked')),
  feeds_ok INTEGER NOT NULL DEFAULT 0,
  feeds_failed INTEGER NOT NULL DEFAULT 0,
  sources_failed TEXT[] NOT NULL DEFAULT '{}',
  seen INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  skipped_duplicate INTEGER NOT NULL DEFAULT 0,
  skipped_irrelevant INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_started
  ON ingest_runs (started_at DESC);

-- First-party feed personalization. Recommendation vectors are deterministic
-- local features, not third-party AI embeddings.
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

ALTER TABLE posts ADD COLUMN IF NOT EXISTS recommendation_embedding REAL[];
ALTER TABLE articles ADD COLUMN IF NOT EXISTS recommendation_embedding REAL[];

CREATE TABLE IF NOT EXISTS email_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('verify', 'reset')),
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens (user_id, kind);

CREATE TABLE IF NOT EXISTS ai_usage (
  user_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  requests INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_posts_topic      ON posts(general_topic_id);
CREATE INDEX IF NOT EXISTS idx_posts_created    ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_user       ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_tsv        ON posts USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_articles_topic   ON articles(general_topic_id);
CREATE INDEX IF NOT EXISTS idx_articles_status  ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_created ON articles(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_tsv      ON articles USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_articles_ai_context_recent
  ON articles(published_at DESC) WHERE status = 'ready' AND ai_context_allowed;
CREATE INDEX IF NOT EXISTS idx_comments_post    ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_article ON comments(article_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent  ON comments(parent_comment_id);
CREATE INDEX IF NOT EXISTS idx_votes_post       ON votes(post_id);
CREATE INDEX IF NOT EXISTS idx_article_votes_article ON article_votes(article_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);

-- ============================================================
-- Seed: general_topics
-- UUIDs preserved from the existing app so profile.tsx keeps working
-- until Phase 3 migration
-- ============================================================

INSERT INTO general_topics (id, name, slug, importance) VALUES
  ('8c4a1a64-d3b6-4eb2-b86c-d9af397cdb1e', 'Elections & Government', 'elections',     7),
  ('b2341048-0108-450d-91ae-d0f509f6f574', 'Foreign Policy & Defense','foreign-policy',5),
  ('f289ef45-488d-46cf-aad2-d045453f4875', 'Economy & Jobs',          'economy',       6),
  ('49abf187-8b6b-419d-a093-a76dc7104819', 'Tech & Innovation',       'tech',          4),
  ('d2cfb810-94f0-4446-982c-38ad27585bca', 'Immigration & Border',    'immigration',   6),
  ('2e6042ef-4598-42a8-8624-1eb961845cbd', 'Health & Environment',    'health',        5),
  ('95f37b29-a5f9-432b-a411-b5ba1e16a493', 'Rights & Freedoms',       'rights',        5)
ON CONFLICT (id) DO NOTHING;
