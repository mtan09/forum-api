import { Hono } from 'hono'
import pool, { query } from '../db'
import { publicArticleFields } from '../lib/article-public'
import { optionalAuth, requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

const articles = new Hono<AppEnv>()

// $1 is always the caller's user id (or null) so my_vote comes back
// joined when the request is authenticated.
const ARTICLE_SELECT = `
  SELECT ${publicArticleFields('a')},
         v.direction AS my_vote,
         EXISTS(SELECT 1 FROM bookmarks b WHERE b.article_id = a.id AND b.user_id = $1) AS my_bookmark
  FROM articles a
  LEFT JOIN article_votes v ON v.article_id = a.id AND v.user_id = $1
`

// GET /articles?topic_id=X&subtopic_id=Y&limit=30&offset=0 — newest first
articles.get('/', optionalAuth, async (c) => {
  const topicId = c.req.query('topic_id')
  const subtopicId = c.req.query('subtopic_id')
  const limit = Math.min(Number(c.req.query('limit')) || 100, 100)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)

  const params: unknown[] = [c.get('userId') ?? null]
  const conditions = ["a.status = 'ready'"]
  if (topicId) {
    params.push(topicId)
    conditions.push(`a.general_topic_id = $${params.length}`)
  }
  if (subtopicId) {
    params.push(subtopicId)
    conditions.push(`a.subtopic_id = $${params.length}`)
  }
  params.push(limit, offset)

  const result = await query(
    `${ARTICLE_SELECT}
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.published_at DESC NULLS LAST, a.id
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )
  return c.json(result.rows)
})

// GET /articles/:id
articles.get('/:id', optionalAuth, async (c) => {
  const result = await query(`${ARTICLE_SELECT} WHERE a.id = $2`, [
    c.get('userId') ?? null,
    c.req.param('id'),
  ])
  if (!result.rows[0]) return c.json({ error: 'Article not found' }, 404)
  return c.json(result.rows[0])
})

// POST /articles/:id/vote  { direction: 'up' | 'down' | null }
// Same transactional pattern as post votes: upsert/clear, then recompute
// the counters from article_votes so they can never drift.
articles.post('/:id/vote', requireAuth, async (c) => {
  const articleId = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const direction = body?.direction ?? null
  if (direction !== 'up' && direction !== 'down' && direction !== null) {
    return c.json({ error: "direction must be 'up', 'down', or null." }, 400)
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (direction === null) {
      await client.query(
        'DELETE FROM article_votes WHERE user_id = $1 AND article_id = $2',
        [c.get('userId'), articleId]
      )
    } else {
      await client.query(
        `INSERT INTO article_votes (user_id, article_id, direction) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, article_id) DO UPDATE SET direction = $3, created_at = NOW()`,
        [c.get('userId'), articleId, direction]
      )
    }
    const updated = await client.query(
      `UPDATE articles SET
         upvotes   = (SELECT count(*) FROM article_votes WHERE article_id = $1 AND direction = 'up'),
         downvotes = (SELECT count(*) FROM article_votes WHERE article_id = $1 AND direction = 'down')
       WHERE id = $1
       RETURNING upvotes, downvotes`,
      [articleId]
    )
    await client.query('COMMIT')

    if (!updated.rows[0]) return c.json({ error: 'Article not found' }, 404)
    return c.json({ ...updated.rows[0], my_vote: direction })
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
})

export default articles
