import { Hono } from 'hono'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

const users = new Hono<AppEnv>()

const PUBLIC_USER_COLS = 'id, username, avatar_url, bio, header_url, created_at'

// GET /users/me — current user's profile including email
users.get('/me', requireAuth, async (c) => {
  const result = await query(
    `SELECT u.id, u.username, u.avatar_url, u.bio, u.header_url, u.created_at, a.email
     FROM userdata u
     LEFT JOIN auth_credentials a ON a.user_id = u.id
     WHERE u.id = $1`,
    [c.get('userId')]
  )
  if (!result.rows[0]) return c.json({ error: 'User not found' }, 404)
  return c.json(result.rows[0])
})

// PATCH /users/me — update username, bio, avatar_url, header_url
users.patch('/me', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'Invalid body' }, 400)

  const fields: Record<string, string | null> = {}
  if (body.username !== undefined) {
    const username = String(body.username).trim()
    if (username.length < 3 || username.length > 24) {
      return c.json({ error: 'Username must be 3–24 characters.' }, 400)
    }
    fields.username = username
  }
  for (const key of ['bio', 'avatar_url', 'header_url'] as const) {
    if (body[key] !== undefined) fields[key] = body[key] === null ? null : String(body[key])
  }
  if (Object.keys(fields).length === 0) {
    return c.json({ error: 'Nothing to update' }, 400)
  }

  const keys = Object.keys(fields)
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ')
  try {
    const result = await query(
      `UPDATE userdata SET ${sets} WHERE id = $1 RETURNING ${PUBLIC_USER_COLS}`,
      [c.get('userId'), ...keys.map((k) => fields[k])]
    )
    return c.json(result.rows[0])
  } catch (err: any) {
    if (err?.code === '23505') return c.json({ error: 'Username is already taken.' }, 409)
    throw err
  }
})

// GET /users/me/positions — per-topic political positions
users.get('/me/positions', requireAuth, async (c) => {
  const result = await query(
    'SELECT topic_id, position, updated_at FROM user_positions WHERE user_id = $1',
    [c.get('userId')]
  )
  return c.json(result.rows)
})

// POST /users/me/positions  { topic_id, position } — upsert
users.post('/me/positions', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null)
  const topicId = String(body?.topic_id ?? '')
  const position = Number(body?.position)
  if (!topicId || !Number.isFinite(position) || position < 0 || position > 1) {
    return c.json({ error: 'topic_id and position (0–1) are required.' }, 400)
  }
  const result = await query(
    `INSERT INTO user_positions (user_id, topic_id, position, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, topic_id) DO UPDATE SET position = $3, updated_at = NOW()
     RETURNING topic_id, position, updated_at`,
    [c.get('userId'), topicId, position]
  )
  return c.json(result.rows[0])
})

// GET /users?ids=a,b,c — batch public profiles
users.get('/', requireAuth, async (c) => {
  const ids = (c.req.query('ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (ids.length === 0) return c.json([])
  const result = await query(
    `SELECT ${PUBLIC_USER_COLS} FROM userdata WHERE id = ANY($1)`,
    [ids]
  )
  return c.json(result.rows)
})

// GET /users/:id — public profile
users.get('/:id', requireAuth, async (c) => {
  const result = await query(
    `SELECT ${PUBLIC_USER_COLS} FROM userdata WHERE id = $1`,
    [c.req.param('id')]
  )
  if (!result.rows[0]) return c.json({ error: 'User not found' }, 404)
  return c.json(result.rows[0])
})

export default users
