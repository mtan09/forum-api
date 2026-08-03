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
       to_regclass('public.demo_personas') IS NOT NULL AS demo_personas,
       to_regclass('public.demo_activity_jobs') IS NOT NULL AS demo_activity_jobs`
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
  console.log('Release migration verified: schema present; seeded John is a locked fictional demo')
}

main()
  .catch((err) => {
    console.error('Release verification failed:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
