import { Hono } from 'hono'
import pool, { query } from '../db'
import { normalizeHashtags } from '../lib/hashtags'
import { matchTopic } from '../ingest/topics'
import { notify } from '../lib/push'
import { requireAuth } from '../middleware/auth'
import { rateLimit } from '../middleware/rateLimit'
import { scorePost } from '../scoring/score'
import type { AppEnv } from '../types'

const posts = new Hono<AppEnv>()

const POST_SELECT = `
  SELECT p.id, p.user_id, p.content, p.media_url, p.general_topic_id, p.position,
         p.position_confidence, p.position_signals, p.scorer_version,
         p.hashtags, p.upvotes, p.downvotes, p.commentcount, p.created_at,
         u.username, u.avatar_url,
         v.direction AS my_vote,
         EXISTS(SELECT 1 FROM bookmarks b WHERE b.post_id = p.id AND b.user_id = $1) AS my_bookmark
  FROM posts p
  JOIN userdata u ON u.id = p.user_id
  LEFT JOIN votes v ON v.post_id = p.id AND v.user_id = $1
`

// Rows authored by someone the caller has blocked never leave the API
const NOT_BLOCKED = `NOT EXISTS(
  SELECT 1 FROM blocks bl WHERE bl.blocker_id = $1 AND bl.blocked_id = p.user_id
)`

// GET /posts?topic_id=X&user_id=Y&limit=50&offset=0 — newest first,
// includes author + caller's vote
posts.get('/', requireAuth, async (c) => {
  const topicId = c.req.query('topic_id')
  const authorId = c.req.query('user_id')
  const feed = c.req.query('feed')
  const limit = Math.min(Number(c.req.query('limit')) || 100, 100)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)

  const params: unknown[] = [c.get('userId')]
  const conditions: string[] = [NOT_BLOCKED, 'NOT p.hidden']
  if (topicId) {
    params.push(topicId)
    conditions.push(`p.general_topic_id = $${params.length}`)
  }
  if (authorId) {
    params.push(authorId)
    conditions.push(`p.user_id = $${params.length}`)
  }
  if (feed === 'following') {
    conditions.push(`p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = $1)`)
  }
  const where = `WHERE ${conditions.join(' AND ')}`
  params.push(limit, offset)

  const result = await query(
    `${POST_SELECT} ${where}
     ORDER BY p.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )
  return c.json(result.rows)
})

// POST /posts  { content, media_url?, hashtags?: string[] }
// Hashtags are author-selected (plus inline #tags in the text). The
// general topic is derived server-side as background metadata, and the
// spectrum position is computed by the deterministic scorer — NULL when
// the text doesn't clear the confidence gate. Client-supplied positions
// are ignored.
posts.post('/', requireAuth, rateLimit({ name: 'createPost', windowMs: 60 * 60_000, max: 30 }), async (c) => {
  const body = await c.req.json().catch(() => null)
  const content = String(body?.content ?? '').trim()
  const mediaUrl = body?.media_url ? String(body.media_url) : null

  if (!content && !mediaUrl) {
    return c.json({ error: 'Post needs text or an image.' }, 400)
  }

  const hashtags = normalizeHashtags(body?.hashtags, content)
  const score = scorePost(content)
  const topic = await matchTopic(`${content} ${hashtags.join(' ')}`)

  const inserted = await query(
    `INSERT INTO posts (user_id, content, media_url, general_topic_id, hashtags,
                        position, position_confidence, position_signals, scorer_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      c.get('userId'), content, mediaUrl, topic.generalTopicId, hashtags,
      score.position, score.confidence, score.signals, score.scorer_version,
    ]
  )
  const result = await query(`${POST_SELECT} WHERE p.id = $2`, [
    c.get('userId'),
    inserted.rows[0].id,
  ])
  return c.json(result.rows[0], 201)
})

// GET /posts/:id — single post with author + caller's vote
posts.get('/:id', requireAuth, async (c) => {
  const result = await query(`${POST_SELECT} WHERE p.id = $2 AND NOT p.hidden`, [
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

    if (direction === 'up') {
      const meta = await query(
        `SELECT p.user_id AS owner_id, u.username AS voter
         FROM posts p, userdata u WHERE p.id = $1 AND u.id = $2`,
        [postId, c.get('userId')]
      )
      const row = meta.rows[0]
      if (row && row.owner_id !== c.get('userId')) {
        notify(row.owner_id, 'upvotes', {
          title: 'Your post got an upvote',
          body: `${row.voter} upvoted your post.`,
          data: { url: `/post/${postId}` },
        })
      }
    }
    return c.json({ ...updated.rows[0], my_vote: direction })
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
})

export default posts
