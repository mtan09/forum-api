-- Support the Daily Brief delivery predicate.
--
-- `processDailyBriefDeliveries` runs every 15 minutes and filters
-- notification_prefs on `timezone IS NOT NULL` plus the two per-channel
-- opt-ins, with nothing indexed behind it — one sequential scan per pass over
-- a row per user. Fine at today's account count, but the article-side code
-- already handles five-figure volume and the post side is expected to match
-- it, so this is the equivalent index rather than a simpler version.
--
-- Partial, because the overwhelming majority of rows will never be selected:
-- only accounts that both set a timezone and opted into a channel qualify.
--
-- Idempotent and non-destructive. Safe to re-run.

CREATE INDEX IF NOT EXISTS idx_notification_prefs_brief_due
  ON notification_prefs (user_id)
  WHERE timezone IS NOT NULL
    AND (email_daily_brief OR push_daily_brief);
