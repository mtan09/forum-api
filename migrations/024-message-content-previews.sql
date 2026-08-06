-- Durable, typed in-app shares. The foreign keys let a message render a
-- compact post/article card without trusting or reparsing its display text.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS shared_post_id UUID REFERENCES posts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS shared_article_id UUID REFERENCES articles(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messages_one_shared_item'
      AND conrelid = 'messages'::regclass
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_one_shared_item CHECK (
        num_nonnulls(shared_post_id, shared_article_id) <= 1
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_messages_shared_post
  ON messages (shared_post_id) WHERE shared_post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_shared_article
  ON messages (shared_article_id) WHERE shared_article_id IS NOT NULL;

-- Preserve older shares created before typed attachments existed. Matching is
-- limited to forum's canonical UUID links and never removes the original text.
UPDATE messages m
SET shared_post_id = p.id
FROM posts p
WHERE m.shared_post_id IS NULL
  AND m.shared_article_id IS NULL
  AND substring(
    m.content FROM '(?i)forumeveryside\.com/post/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
  ) = p.id::text;

UPDATE messages m
SET shared_article_id = a.id
FROM articles a
WHERE m.shared_post_id IS NULL
  AND m.shared_article_id IS NULL
  AND substring(
    m.content FROM '(?i)forumeveryside\.com/article/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
  ) = a.id::text;
