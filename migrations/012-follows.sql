-- Social graph: one-directional follows.
CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows (followee_id);
