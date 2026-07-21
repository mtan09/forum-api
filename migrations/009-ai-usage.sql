-- Per-user daily forumAI usage, so the OpenAI spend cap survives server
-- restarts and works across instances.
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  requests INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
