-- Let the disclosed fictional review community react to newly ingested
-- publisher articles. Jobs remain durable and globally idempotent per
-- article/persona/action.
ALTER TABLE demo_activity_jobs
  DROP CONSTRAINT IF EXISTS demo_activity_jobs_kind_check;

ALTER TABLE demo_activity_jobs
  ADD CONSTRAINT demo_activity_jobs_kind_check CHECK (kind IN (
    'post', 'post_comment', 'post_vote',
    'article_comment', 'article_vote',
    'debate_comment', 'debate_vote', 'comment_vote'
  ));
