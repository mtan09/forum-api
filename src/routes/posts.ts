import { Hono } from 'hono'
import pool, { query } from '../db'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

const posts = new Hono<AppEnv>()

const POST_SELECT = `
  SELECT p.id, p.user_id, p.content, p.media_url, p.general_topic_id, p.position,
         p.upvotes, p.downvotes, p.commentcount, p.created_at,
         u.username, u.avatar_url,
         v.direction AS my_vote
  FROM posts p
  JOIN userdata u ON u.id = p.user_id
  LEFT JOIN votes v ON v.post_id = p.id AND v.user_id = $1
`

// GET /posts?topic_id=X&limit=50&offset=0 — newest first, includes author + caller's vote
posts.get('/', requireAuth, async (c) => {
  const topicId = c.req.query('topic_id')
  const limit = Math.min(Number(c.req.query('limit')) || 100, 100)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)

  const params: unknown[] = [c.get('userId')]
  let where = ''
  if (topicId) {
    params.push(topicId)
    where = `WHERE p.general_topic_id = $${params.length}`
  }
  params.push(limit, offset)

  const result = await query(
    `${POST_SELECT} ${where}
     ORDER BY p.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )
  return c.json(result.rows)
})

// POST /posts  { content, media_url?, general_topic_id?, position? }
posts.post('/', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null)
  const content = String(body?.content ?? '').trim()
  const mediaUrl = body?.media_url ? String(body.media_url) : null
  const topicId = body?.general_topic_id ? String(body.general_topic_id) : null
  const position = body?.position === undefined ? 0.5 : Number(body.position)

  if (!content && !mediaUrl) {
    return c.json({ error: 'Post needs text or an image.' }, 400)
  }
  if (!Number.isFinite(position) || position < 0 || position > 1) {
    return c.json({ error: 'position must be between 0 and 1.' }, 400)
  }

  const inserted = await query(
    `INSERT INTO posts (user_id, content, media_url, general_topic_id, position)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [c.get('userId'), content, mediaUrl, topicId, position]
  )
  const result = await query(`${POST_SELECT} WHERE p.id = $2`, [
    c.get('userId'),
    inserted.rows[0].id,
  ])
  return c.json(result.rows[0], 201)
})

// GET /posts/:id — single post with author + caller's vote
posts.get('/:id', requireAuth, async (c) => {
  const result = await query(`${POST_SELECT} WHERE p.id = $2`, [
    c.get('userId'),
    c.req.param('id'),
  ])
  if (!result.rows[0]) return c.json({ error: 'Post not found' }, 404)
  return c.json(result.rows[0])
})

// POST /posts/:id/vote  { direction: 'up' | 'down' | null }
// Upserts/clears the caller's vote, then recomputes the post's counters
// from the votes table so they can never drift.
posts.post('/:id/vote', requireAuth, async (c) => {
  const postId = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const direction = body?.direction ?? null
  if (direction !== 'up' && direction !== 'down' && direction !== null) {
    return c.json({ error: "direction must be 'up', 'down', or null." }, 400)
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (direction === null) {
      await client.query('DELETE FROM votes WHERE user_id = $1 AND post_id = $2', [
        c.get('userId'),
        postId,
      ])
    } else {
      await client.query(
        `INSERT INTO votes (user_id, post_id, direction) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, post_id) DO UPDATE SET direction = $3, created_at = NOW()`,
        [c.get('userId'), postId, direction]
      )
    }
    const updated = await client.query(
      `UPDATE posts SET
         upvotes   = (SELECT count(*) FROM votes WHERE post_id = $1 AND direction = 'up'),
         downvotes = (SELECT count(*) FROM votes WHERE post_id = $1 AND direction = 'down')
       WHERE id = $1
       RETURNING upvotes, downvotes`,
      [postId]
    )
    await client.query('COMMIT')

    if (!updated.rows[0]) return c.json({ error: 'Post not found' }, 404)
    return c.json({ ...updated.rows[0], my_vote: direction })
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
})

export default posts
