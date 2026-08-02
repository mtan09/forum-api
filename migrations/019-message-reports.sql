-- Direct messages are user-generated content and need the same report/review
-- path as public posts and comments. A hidden message remains in the database
-- for moderation/audit purposes but is no longer returned to participants.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE reports
  DROP CONSTRAINT IF EXISTS reports_target_kind_check;

ALTER TABLE reports
  ADD CONSTRAINT reports_target_kind_check
  CHECK (target_kind IN ('post', 'article', 'comment', 'user', 'message'));
