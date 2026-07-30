import { RIGHTS_POLICY_VERSION } from '../ingest/source-rights'

// One canonical projection for every public article response. Raw `content`
// is intentionally absent. Legacy summaries/signals and unapproved media are
// masked even before the separate destructive cleanup is approved.
export function publicArticleFields(alias = 'a'): string {
  const a = alias
  return `
    ${a}.id,
    ${a}.url,
    ${a}.title,
    ${a}.source,
    CASE
      WHEN ${a}.text_mode IN ('feed_description', 'full_text') THEN ${a}.description
      ELSE NULL
    END AS description,
    CASE
      WHEN ${a}.image_mode IN ('remote_no_cache', 'licensed_cache') THEN ${a}.media
      ELSE NULL
    END AS media,
    ${a}.image_mode,
    ${a}.text_mode,
    ${a}.ai_mode,
    ${a}.political_lean,
    ${a}.political_relevance,
    ${a}.lean_confidence,
    ${a}.content_type,
    CASE
      WHEN ${a}.rights_policy_version = '${RIGHTS_POLICY_VERSION}' THEN ${a}.lean_signals
      ELSE ARRAY[]::text[]
    END AS lean_signals,
    ${a}.source_lean,
    ${a}.scorer_version,
    ${a}.upvotes,
    ${a}.downvotes,
    ${a}.commentcount,
    ${a}.general_topic_id,
    ${a}.subtopic_id,
    ${a}.published_at,
    ${a}.status,
    ${a}.created_at
  `
}
