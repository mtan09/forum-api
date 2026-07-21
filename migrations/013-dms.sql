-- Direct messages: one conversation per user pair (pair stored sorted so
-- the UNIQUE constraint dedupes), plus per-user read state for unread badges.
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_reads (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);
