import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import pool from '../src/db'
import { AI_CONSENT_VERSION } from '../src/lib/ai-consent'
import { hashPassword } from '../src/lib/auth'

const DEMO_DOMAIN = 'example.dev'
const DEMO_BIO = 'Fictional demo account for previewing forum.'
const apply = process.env.DEMO_ACCOUNT_APPLY === 'yes'

async function main() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const accounts = await client.query(
      `SELECT a.user_id, a.email, u.username,
              (SELECT count(*)::int FROM posts p WHERE p.user_id = a.user_id) AS posts,
              (SELECT count(*)::int FROM comments c WHERE c.user_id = a.user_id) AS comments
       FROM auth_credentials a
       JOIN userdata u ON u.id = a.user_id
       WHERE split_part(lower(a.email), '@', 2) = $1
       ORDER BY u.username
       FOR UPDATE OF a, u`,
      [DEMO_DOMAIN]
    )

    const userIds = accounts.rows.map((row) => row.user_id as string)
    const summary = {
      apply,
      domain: DEMO_DOMAIN,
      accounts: userIds.length,
      posts: accounts.rows.reduce((total, row) => total + Number(row.posts), 0),
      comments: accounts.rows.reduce((total, row) => total + Number(row.comments), 0),
      usernames: accounts.rows.map((row) => row.username),
    }

    if (!apply || userIds.length === 0) {
      await client.query('ROLLBACK')
      console.log(JSON.stringify(summary, null, 2))
      if (!apply) console.log('Dry run only. Set DEMO_ACCOUNT_APPLY=yes to apply.')
      return
    }

    for (const userId of userIds) {
      const passwordHash = await hashPassword(randomBytes(32).toString('base64url'))
      await client.query(
        `UPDATE auth_credentials
         SET password_hash = $2, email_verified = FALSE
         WHERE user_id = $1`,
        [userId, passwordHash]
      )
    }

    await client.query(
      `UPDATE userdata
       SET avatar_url = NULL,
           header_url = NULL,
           bio = $2,
           is_admin = FALSE,
           is_banned = FALSE,
           is_private = FALSE
       WHERE id = ANY($1::text[])`,
      [userIds, DEMO_BIO]
    )
    await client.query('DELETE FROM push_tokens WHERE user_id = ANY($1::text[])', [userIds])
    await client.query('DELETE FROM push_receipts WHERE user_id = ANY($1::text[])', [userIds])
    await client.query('DELETE FROM email_tokens WHERE user_id = ANY($1::text[])', [userIds])
    await client.query(
      'DELETE FROM notification_email_digests WHERE user_id = ANY($1::text[])',
      [userIds]
    )
    await client.query(
      `UPDATE notification_prefs
       SET push_enabled = FALSE, email_enabled = FALSE
       WHERE user_id = ANY($1::text[])`,
      [userIds]
    )
    await client.query(
      `INSERT INTO ai_data_consents (user_id, consent_version, status, decided_at)
       SELECT unnest($1::text[]), $2, 'revoked', NOW()
       ON CONFLICT (user_id) DO UPDATE SET
         consent_version = EXCLUDED.consent_version,
         status = 'revoked',
         decided_at = EXCLUDED.decided_at`,
      [userIds, AI_CONSENT_VERSION]
    )

    await client.query('COMMIT')
    console.log(JSON.stringify({ ...summary, applied: true }, null, 2))
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error('Could not harden demo accounts:', err)
  process.exitCode = 1
})
