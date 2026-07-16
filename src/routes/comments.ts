import { Hono } from 'hono'
import pool, { query } from '../db'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

const comments = new Hono<AppEnv>()

const COMMENT_SELECT = `
  SELECT c.id, c.user_id, c.post_id, c.parent_comment_id, c.content, c.created_at,
         u.username, u.avatar_url,
         (SELECT count(*)::int FROM comments r WHERE r.parent_comment_id = c.id) AS reply_count
  FROM comments c
  JOIN userdata u ON u.id = c.user_id
`

// GET /comments?post_id=X&page=0&limit=10 — top-level comments of a post
// GET /comments?parent_comment_id=X&page=0&limit=5 — replies to a comment
comments.get('/', requireAuth, async (c) => {
  const postId = c.req.query('post_id')
  const parentId = c.req.query('parent_comment_id')
  const limit = Math.min(Number(c.req.query('limit')) || 10, 50)
  const page = Math.max(Number(c.req.query('page')) || 0, 0)

  if (!postId && !parentId) {
    return c.json({ error: 'post_id or parent_comment_id is required.' }, 400)
  }

  const where = parentId
    ? 'WHERE c.parent_comment_id = $1'
    : 'WHERE c.post_id = $1 AND c.parent_comment_id IS NULL'

  const result = await query(
    `${COMMENT_SELECT} ${where}
     ORDER BY c.created_at ASC
     LIMIT $2 OFFSET $3`,
    [parentId ?? postId, limit + 1, page * limit]
  )

  const hasMore = result.rows.length > limit
  return c.json({ comments: result.rows.slice(0, limit), hasMore })
})

// POST /comments  { post_id?, parent_comment_id?, content }
comments.post('/', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null)
  const content = String(body?.content ?? '').trim()
  const parentId = body?.parent_comment_id ? String(body.parent_comment_id) : null
  let postId = body?.post_id ? String(body.post_id) : null

  if (!content) return c.json({ error: 'Comment cannot be empty.' }, 400)

  // Replies inherit the parent's post so the two can never disagree
  if (parentId) {
    const parent = await query('SELECT post_id FROM comments WHERE id = $1', [parentId])
    if (!parent.rows[0]) return c.json({ error: 'Parent comment not found.' }, 404)
    postId = parent.rows[0].post_id
  }
  if (!postId) return c.json({ error: 'post_id or parent_comment_id is required.' }, 400)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const inserted = await client.query(
      `INSERT INTO comments (user_id, post_id, parent_comment_id, content)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [c.get('userId'), postId, parentId, content]
    )
    await client.query('UPDATE posts SET commentcount = commentcount + 1 WHERE id = $1', [
      postId,
    ])
    await client.query('COMMIT')

    const result = await query(`${COMMENT_SELECT} WHERE c.id = $1`, [inserted.rows[0].id])
    return c.json(result.rows[0], 201)
  } catch (err: any) {
    await client.query('ROLLBACK')
    if (err?.code === '23503') return c.json({ error: 'Post not found.' }, 404)
    throw err
  } finally {
    client.release()
  }
})

export default comments
