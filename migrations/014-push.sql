-- Push notifications: device tokens + per-user notification preferences
-- (the server checks prefs before every send, so the app's toggles are real).
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
  replies BOOLEAN NOT NULL DEFAULT TRUE,
  upvotes BOOLEAN NOT NULL DEFAULT TRUE,
  dms BOOLEAN NOT NULL DEFAULT TRUE
);
