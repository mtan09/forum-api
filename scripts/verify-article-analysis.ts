import 'dotenv/config'
import pool from '../src/db'
import { ARTICLE_EVIDENCE_VERSION } from '../src/ingest/article-evidence'
import { RIGHTS_POLICY_VERSION } from '../src/ingest/source-rights'

async function main() {
  const schema = await pool.query(
    `SELECT
       to_regclass('public.article_evidence') IS NOT NULL AS evidence_table,
       to_regclass('public.article_analysis_usage') IS NOT NULL AS usage_table,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'articles'
           AND column_name = 'media_thumbnail_url'
       ) AS managed_media,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'ingest_runs'
           AND column_name = 'evidence_generated'
       ) AS ingest_metrics`
  )
  const missing = Object.entries(schema.rows[0]).filter(([, value]) => value !== true)
  if (missing.length > 0) {
    throw new Error(`Missing article-analysis schema: ${missing.map(([key]) => key).join(', ')}`)
  }

  const counts = await pool.query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE a.rights_policy_version = $1)::int AS current_policy,
       count(*) FILTER (WHERE e.extraction_version = $2)::int AS current_evidence,
       count(*) FILTER (WHERE a.content IS NOT NULL AND a.rights_policy_version = $1)::int
         AS current_rows_with_raw_content,
       count(*) FILTER (WHERE a.image_mode = 'managed_thumbnail'
                         AND a.media_thumbnail_url IS NOT NULL)::int AS managed_images,
       count(*) FILTER (WHERE a.image_mode = 'remote_no_cache')::int AS remote_fallbacks,
       count(*) FILTER (WHERE a.media_status = 'failed')::int AS image_failures,
       count(*) FILTER (WHERE e.generated_by = 'openai')::int AS ai_evidence,
       count(*) FILTER (WHERE e.generated_by = 'deterministic')::int AS deterministic_evidence
     FROM articles a
     LEFT JOIN article_evidence e ON e.article_id = a.id`,
    [RIGHTS_POLICY_VERSION, ARTICLE_EVIDENCE_VERSION]
  )
  const result = counts.rows[0]
  if (Number(result.current_rows_with_raw_content) > 0) {
    throw new Error(
      `${result.current_rows_with_raw_content} current-policy articles still contain raw text`
    )
  }
  console.log(JSON.stringify({
    rights_policy_version: RIGHTS_POLICY_VERSION,
    evidence_version: ARTICLE_EVIDENCE_VERSION,
    ...result,
  }, null, 2))
}

main()
  .catch((error) => {
    console.error('Article analysis verification failed:', error)
    process.exitCode = 1
  })
  .finally(() => pool.end())

