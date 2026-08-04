import 'dotenv/config'
import { randomBytes, randomUUID } from 'node:crypto'
import pool from '../src/db'
import { hashPassword } from '../src/lib/auth'

async function main() {
  const email = String(process.env.RELEASE_ACCOUNT_EMAIL ?? '').trim().toLowerCase()
  const username = String(process.env.RELEASE_ACCOUNT_USERNAME ?? '').trim()
  const role = process.env.RELEASE_ACCOUNT_ROLE === 'owner' ? 'owner' : 'reviewer'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Set RELEASE_ACCOUNT_EMAIL to the account email.')
  }
  if (username.length < 3 || username.length > 24) {
    throw new Error('Set RELEASE_ACCOUNT_USERNAME to 3–24 characters.')
  }
  if (email.endsWith('@example.dev')) {
    throw new Error('Release accounts cannot use the documented development domain.')
  }
  const password =
    process.env.RELEASE_ACCOUNT_PASSWORD ??
    randomBytes(24).toString('base64url')
  const shouldPrintPassword = process.env.RELEASE_ACCOUNT_PRINT_PASSWORD !== 'no'
  const passwordHash = await hashPassword(password)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const existing = await client.query(
      'SELECT user_id FROM auth_credentials WHERE email = $1',
      [email]
    )
    const userId = existing.rows[0]?.user_id ?? randomUUID()
    if (existing.rows[0]) {
      await client.query(
        `UPDATE userdata
         SET username = $2, is_admin = $3, is_banned = FALSE, is_private = FALSE
         WHERE id = $1`,
        [userId, username, role === 'owner']
      )
      await client.query(
        `UPDATE auth_credentials
         SET password_hash = $2, email_verified = TRUE
         WHERE user_id = $1`,
        [userId, passwordHash]
      )
    } else {
      await client.query(
        `INSERT INTO userdata (id, username, is_admin) VALUES ($1, $2, $3)`,
        [userId, username, role === 'owner']
      )
      await client.query(
        `INSERT INTO auth_credentials (user_id, email, password_hash, email_verified)
         VALUES ($1, $2, $3, TRUE)`,
        [userId, email, passwordHash]
      )
    }
    await client.query('COMMIT')
    console.log(`Created ${role} release account.`)
    console.log(`Email: ${email}`)
    if (shouldPrintPassword) {
      console.log(`Password: ${password}`)
      console.log('Store this password only in your password manager or App Store Connect.')
    } else {
      console.log('Password output suppressed; use the securely supplied password value.')
    }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error('Could not create release account:', err)
  process.exitCode = 1
})
