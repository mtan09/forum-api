import 'dotenv/config'
import pool from '../src/db'
import { verifyPassword } from '../src/lib/auth'

async function main() {
  const schema = await pool.query(
    `SELECT
       to_regclass('public.moderation_audits') IS NOT NULL AS moderation_audits,
       to_regclass('public.beta_feedback') IS NOT NULL AS beta_feedback,
       to_regclass('public.deletion_jobs') IS NOT NULL AS deletion_jobs,
       to_regclass('public.ingest_runs') IS NOT NULL AS ingest_runs,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'userdata'
           AND column_name = 'is_private'
       ) AS private_accounts,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'follows'
           AND column_name = 'status'
       ) AS follow_status,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'userdata'
           AND column_name = 'is_demo'
       ) AS demo_accounts,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'articles'
           AND column_name = 'analysis_profile'
       ) AS derived_article_profiles,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'articles'
           AND column_name = 'ai_context_allowed'
       ) AS article_ai_policy,
       to_regclass('public.demo_personas') IS NOT NULL AS demo_personas,
       to_regclass('public.demo_activity_jobs') IS NOT NULL AS demo_activity_jobs,
       EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'demo_activity_jobs_kind_check'
           AND pg_get_constraintdef(oid) LIKE '%article_vote%'
           AND pg_get_constraintdef(oid) LIKE '%article_comment%'
       ) AS demo_article_activity,
       EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conrelid = 'beta_feedback'::regclass
           AND conname = 'beta_feedback_user_id_fkey'
           AND confdeltype = 'c'
       ) AS feedback_delete_cascade`
  )
  const releaseIdentities = await pool.query(
    `SELECT lower(a.email) AS email, a.email_verified, u.is_admin, u.is_demo, u.is_banned
     FROM auth_credentials a
     JOIN userdata u ON u.id = a.user_id
     WHERE lower(a.email) IN ('michael.chinyuan@gmail.com', 'appreview@forumeveryside.com')`
  )
  const john = await pool.query(
    `SELECT
       COUNT(a.user_id)::int AS credentials,
       MAX(a.password_hash) AS password_hash,
       COALESCE(bool_or(u.is_admin), FALSE) AS is_admin,
       COALESCE(bool_or(u.is_demo), FALSE) AS is_demo
     FROM userdata u
     LEFT JOIN auth_credentials a
       ON a.user_id = u.id AND lower(a.email) = 'john@example.dev'
     WHERE lower(u.username) = 'john doe'
        OR lower(COALESCE(a.email, '')) = 'john@example.dev'`
  )
  const checks = schema.rows[0]
  const failed = Object.entries(checks).filter(([, value]) => value !== true)
  if (failed.length > 0) {
    throw new Error(`Release schema checks failed: ${failed.map(([key]) => key).join(', ')}`)
  }
  const identities = new Map(releaseIdentities.rows.map((row) => [String(row.email), row]))
  const owner = identities.get('michael.chinyuan@gmail.com')
  const reviewer = identities.get('appreview@forumeveryside.com')
  if (
    !owner?.email_verified || !owner?.is_admin || owner?.is_demo || owner?.is_banned ||
    !reviewer?.email_verified || reviewer?.is_admin || reviewer?.is_demo || reviewer?.is_banned
  ) {
    throw new Error('Owner or App Review account is missing, unverified, or has the wrong release role')
  }
  const articleStorage = await pool.query(
    `SELECT
       count(*) FILTER (WHERE content IS NOT NULL)::int AS stored_bodies,
       count(*) FILTER (WHERE analysis_profile IS NULL OR analysis_text IS NULL)::int AS missing_profiles,
       pg_get_expr(ad.adbin, ad.adrelid) NOT ILIKE '%content%' AS search_excludes_body,
       EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'articles_content_not_stored' AND convalidated
       ) AS storage_constraint
     FROM articles
     JOIN pg_attribute attr
       ON attr.attrelid = 'articles'::regclass AND attr.attname = 'search_tsv'
     JOIN pg_attrdef ad
       ON ad.adrelid = attr.attrelid AND ad.adnum = attr.attnum
     GROUP BY ad.adbin, ad.adrelid`
  )
  if (
    Number(articleStorage.rows[0]?.stored_bodies ?? -1) !== 0 ||
    Number(articleStorage.rows[0]?.missing_profiles ?? -1) !== 0 ||
    articleStorage.rows[0]?.search_excludes_body !== true ||
    articleStorage.rows[0]?.storage_constraint !== true
  ) {
    throw new Error('Article bodies are not fully scrubbed or the derived-feature invariant is incomplete')
  }
  const johnPasswordWorks = john.rows[0]?.password_hash
    ? await verifyPassword('password123', john.rows[0].password_hash)
    : false
  if (
    Number(john.rows[0]?.credentials ?? 0) !== 1 ||
    johnPasswordWorks ||
    john.rows[0]?.is_admin ||
    !john.rows[0]?.is_demo
  ) {
    throw new Error('The seeded John account is not safely hardened as a fictional demo')
  }
  console.log('Release verified: schema, transient article analysis, demo activity, and release identities are ready')
}

main()
  .catch((err) => {
    console.error('Release verification failed:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
