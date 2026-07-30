import 'dotenv/config'
import pool from '../src/db'
import { RIGHTS_POLICY_VERSION } from '../src/ingest/source-rights'

async function main() {
  const schema = await pool.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'articles'
           AND column_name = 'rights_policy_version'
       ) AS rights_policy,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'articles'
           AND column_name = 'search_text'
       ) AS search_text,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'subtopics'
           AND column_name = 'summary_policy_version'
       ) AS summary_policy`
  )
  const failedSchema = Object.entries(schema.rows[0]).filter(([, value]) => value !== true)
  if (failedSchema.length > 0) {
    throw new Error(`Missing rights schema: ${failedSchema.map(([key]) => key).join(', ')}`)
  }

  const rows = await pool.query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE rights_policy_version = $1)::int AS current_policy,
       count(*) FILTER (WHERE search_text <> '')::int AS searchable,
       count(*) FILTER (WHERE image_mode <> 'none')::int AS image_enabled,
       count(*) FILTER (WHERE ai_mode = 'permitted_text')::int AS ai_text_enabled
     FROM articles`,
    [RIGHTS_POLICY_VERSION]
  )
  const counts = rows.rows[0]
  if (counts.total > 0 && counts.current_policy !== counts.total) {
    throw new Error(
      `Only ${counts.current_policy}/${counts.total} articles use policy ${RIGHTS_POLICY_VERSION}`
    )
  }
  if (counts.total > 0 && counts.searchable !== counts.total) {
    throw new Error(`Only ${counts.searchable}/${counts.total} articles have metadata search text`)
  }
  console.log(JSON.stringify({ policy_version: RIGHTS_POLICY_VERSION, ...counts }, null, 2))
}

main()
  .catch((err) => {
    console.error('Rights migration verification failed:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
