import { Hono } from 'hono'
import pool from '../db'
import { requireAuth } from '../middleware/auth'
import { rateLimit } from '../middleware/rateLimit'
import type { AppEnv } from '../types'

const reposts = new Hono<AppEnv>()
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

reposts.post('/toggle', requireAuth, rateLimit({ name: 'repost', windowMs: 60_000, max: 60 }), async (c) => {
  const body = await c.req.json().catch(() => null)
  const postId = typeof body?.post_id === 'string' && UUID_RE.test(body.post_id) ? body.post_id : null
  const articleId = typeof body?.article_id === 'string' && UUID_RE.test(body.article_id) ? body.article_id : null
  if (!postId === !articleId) {
    return c.json({ error: 'Provide exactly one post_id or article_id.' }, 400)
  }

  const userId = c.get('userId')
  const column = postId ? 'post_id' : 'article_id'
  const targetId = postId ?? articleId
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Serialize repeated taps for one user/item pair without locking the source
    // content row or blocking unrelated interactions.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`repost:${userId}:${column}:${targetId}`]
    )

    const removed = await client.query(
      `DELETE FROM reposts WHERE user_id = $1 AND ${column} = $2 RETURNING user_id`,
      [userId, targetId]
    )
    let reposted = false
    if (removed.rows.length === 0) {
      const target = postId
        ? await client.query(
          `SELECT p.id
           FROM posts p
           WHERE p.id = $2 AND NOT p.hidden
             AND NOT EXISTS (
               SELECT 1 FROM blocks b
               WHERE (b.blocker_id = $1 AND b.blocked_id = p.user_id)
                  OR (b.blocker_id = p.user_id AND b.blocked_id = $1)
             )`,
          [userId, targetId]
        )
        : await client.query(
          `SELECT id FROM articles WHERE id = $1 AND status = 'ready'`,
          [targetId]
        )
      if (!target.rows[0]) {
        await client.query('ROLLBACK')
        return c.json({ error: 'Content not found.' }, 404)
      }
      await client.query(
        `INSERT INTO reposts (user_id, ${column}) VALUES ($1, $2)`,
        [userId, targetId]
      )
      reposted = true
    }

    const count = await client.query(
      postId
        ? `SELECT (
             (SELECT count(*) FROM reposts WHERE post_id = $1) +
             (SELECT count(*) FROM posts WHERE quoted_post_id = $1 AND NOT hidden)
           )::int AS repost_count`
        : `SELECT (
             (SELECT count(*) FROM reposts WHERE article_id = $1) +
             (SELECT count(*) FROM posts WHERE quoted_article_id = $1 AND NOT hidden)
           )::int AS repost_count`,
      [targetId]
    )
    await client.query('COMMIT')
    return c.json({ reposted, repost_count: count.rows[0]?.repost_count ?? 0 })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

export default reposts
