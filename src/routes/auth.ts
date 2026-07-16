import { randomUUID } from 'crypto'
import { Hono } from 'hono'
import pool from '../db'
import { hashPassword, issueToken, verifyPassword } from '../lib/auth'
import type { AppEnv } from '../types'

const auth = new Hono<AppEnv>()

const PUBLIC_USER_COLS = 'id, username, avatar_url, bio, header_url, created_at'

// POST /auth/signup  { username, email, password }
auth.post('/signup', async (c) => {
  const body = await c.req.json().catch(() => null)
  const username = String(body?.username ?? '').trim()
  const email = String(body?.email ?? '').trim().toLowerCase()
  const password = String(body?.password ?? '')

  if (username.length < 3 || username.length > 24) {
    return c.json({ error: 'Username must be 3–24 characters.' }, 400)
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Enter a valid email address.' }, 400)
  }
  if (password.length < 6) {
    return c.json({ error: 'Password must be at least 6 characters.' }, 400)
  }

  const userId = randomUUID()
  const passwordHash = await hashPassword(password)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const userResult = await client.query(
      `INSERT INTO userdata (id, username) VALUES ($1, $2) RETURNING ${PUBLIC_USER_COLS}`,
      [userId, username]
    )
    await client.query(
      'INSERT INTO auth_credentials (user_id, email, password_hash) VALUES ($1, $2, $3)',
      [userId, email, passwordHash]
    )
    await client.query('COMMIT')

    const token = await issueToken(userId)
    return c.json({ token, user: { ...userResult.rows[0], email } }, 201)
  } catch (err: any) {
    await client.query('ROLLBACK')
    if (err?.code === '23505') {
      const taken = String(err.constraint ?? '').includes('email') ? 'Email' : 'Username'
      return c.json({ error: `${taken} is already taken.` }, 409)
    }
    throw err
  } finally {
    client.release()
  }
})

// POST /auth/login  { email, password }
auth.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null)
  const email = String(body?.email ?? '').trim().toLowerCase()
  const password = String(body?.password ?? '')

  if (!email || !password) {
    return c.json({ error: 'Email and password are required.' }, 400)
  }

  const result = await pool.query(
    `SELECT u.id, u.username, u.avatar_url, u.bio, u.header_url, u.created_at,
            a.email, a.password_hash
     FROM auth_credentials a
     JOIN userdata u ON u.id = a.user_id
     WHERE a.email = $1`,
    [email]
  )

  const row = result.rows[0]
  const valid = row ? await verifyPassword(password, row.password_hash) : false
  if (!valid) {
    return c.json({ error: 'Invalid email or password.' }, 401)
  }

  const { password_hash: _hash, ...user } = row
  const token = await issueToken(user.id)
  return c.json({ token, user })
})

export default auth
