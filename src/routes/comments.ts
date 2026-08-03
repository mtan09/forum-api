import { Hono } from 'hono'
import pool, { query } from '../db'
import { notify } from '../lib/push'
import { moderateText, moderationFailure } from '../lib/moderation'
import { requireAuth } from '../middleware/auth'
import { rateLimit } from '../middleware/rateLimit'
import type { AppEnv } from '../types'

const comments = new Hono<AppEnv>()

// $1 is always the caller's user id so my_vote comes back joined in.
const COMMENT_SELECT = `
  SELECT c.id, c.user_id, c.post_id, c.article_id, c.debate_id, c.parent_comment_id, c.content, c.created_at,
         c.upvotes, c.downvotes,
         u.username, u.avatar_url, u.is_demo,
         v.direction AS my_vote,
         (SELECT count(*)::int FROM comments r WHERE r.parent_comment_id = c.id) AS reply_count
  FROM comments c
  JOIN userdata u ON u.id = c.user_id
  LEFT JOIN comment_votes v ON v.comment_id = c.id AND v.user_id = $1
`

// GET /comments?post_id=X&page=0&limit=10 — top-level comments of a post
// GET /comments?article_id=X&page=0&limit=10 — top-level comments of an article
// GET /comments?debate_id=X&page=0&limit=10 — a debate's shared thread
// GET /comments?parent_comment_id=X&page=0&limit=5 — replies to a comment
comments.get('/', requireAuth, async (c) => {
  const postId = c.req.query('post_id')
  const articleId = c.req.query('article_id')
  const debateId = c.req.query('debate_id')
  const parentId = c.req.query('parent_comment_id')
  const limit = Math.min(Number(c.req.query('limit')) || 10, 50)
  const page = Math.max(Number(c.req.query('page')) || 0, 0)

  if (!postId && !articleId && !debateId && !parentId) {
    return c.json({ error: 'post_id, article_id, debate_id, or parent_comment_id is required.' }, 400)
  }

  const where = parentId
    ? 'WHERE c.parent_comment_id = $2'
    : debateId
      ? 'WHERE c.debate_id = $2 AND c.parent_comment_id IS NULL'
      : articleId
        ? 'WHERE c.article_id = $2 AND c.parent_comment_id IS NULL'
        : 'WHERE c.post_id = $2 AND c.parent_comment_id IS NULL'

  const result = await query(
    `${COMMENT_SELECT} ${where}
       AND NOT c.hidden
       AND NOT EXISTS(SELECT 1 FROM blocks bl WHERE bl.blocker_id = $1 AND bl.blocked_id = c.user_id)
     ORDER BY c.created_at ASC
     LIMIT $3 OFFSET $4`,
    [c.get('userId'), parentId ?? debateId ?? articleId ?? postId, limit + 1, page * limit]
  )

  const hasMore = result.rows.length > limit
  return c.json({ comments: result.rows.slice(0, limit), hasMore })
})

// POST /comments/:id/vote  { direction: 'up' | 'down' | null }
comments.post('/:id/vote', requireAuth, async (c) => {
  const commentId = c.req.param('id')
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
        'DELETE FROM comment_votes WHERE user_id = $1 AND comment_id = $2',
        [c.get('userId'), commentId]
      )
    } else {
      await client.query(
        `INSERT INTO comment_votes (user_id, comment_id, direction) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, comment_id) DO UPDATE SET direction = $3, created_at = NOW()`,
        [c.get('userId'), commentId, direction]
      )
    }
    const updated = await client.query(
      `UPDATE comments SET
         upvotes   = (SELECT count(*) FROM comment_votes WHERE comment_id = $1 AND direction = 'up'),
         downvotes = (SELECT count(*) FROM comment_votes WHERE comment_id = $1 AND direction = 'down')
       WHERE id = $1
       RETURNING upvotes, downvotes`,
      [commentId]
    )
    await client.query('COMMIT')

    if (!updated.rows[0]) return c.json({ error: 'Comment not found' }, 404)
    return c.json({ ...updated.rows[0], my_vote: direction })
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
})

// POST /comments  { post_id? | article_id? | debate_id? | parent_comment_id?, content }
comments.post('/', requireAuth, rateLimit({ name: 'createComment', windowMs: 60 * 60_000, max: 120 }), async (c) => {
  const body = await c.req.json().catch(() => null)
  const content = String(body?.content ?? '').trim()
  const parentId = body?.parent_comment_id ? String(body.parent_comment_id) : null
  let postId = body?.post_id ? String(body.post_id) : null
  let articleId = body?.article_id ? String(body.article_id) : null
  let debateId = body?.debate_id ? String(body.debate_id) : null

  if (!content) return c.json({ error: 'Comment cannot be empty.' }, 400)
  const moderation = await moderateText(c.get('userId'), 'comment', content)
  const moderationError = moderationFailure(moderation)
  if (moderationError) return c.json(moderationError.body, moderationError.status)

  // Replies inherit the parent's target so the two can never disagree
  if (parentId) {
    const parent = await query('SELECT post_id, article_id, debate_id FROM comments WHERE id = $1', [parentId])
    if (!parent.rows[0]) return c.json({ error: 'Parent comment not found.' }, 404)
    postId = parent.rows[0].post_id
    articleId = parent.rows[0].article_id
    debateId = parent.rows[0].debate_id
  }
  if (!postId && !articleId && !debateId) {
    return c.json({ error: 'post_id, article_id, debate_id, or parent_comment_id is required.' }, 400)
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const inserted = await client.query(
      `INSERT INTO comments (user_id, post_id, article_id, debate_id, parent_comment_id, content)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [c.get('userId'), postId, articleId, debateId, parentId, content]
    )
    if (postId) {
      await client.query('UPDATE posts SET commentcount = commentcount + 1 WHERE id = $1', [postId])
    }
    if (articleId) {
      await client.query('UPDATE articles SET commentcount = commentcount + 1 WHERE id = $1', [articleId])
    }
    await client.query('COMMIT')

    const result = await query(`${COMMENT_SELECT} WHERE c.id = $2`, [
      c.get('userId'),
      inserted.rows[0].id,
    ])

    // Reply notifications: the parent comment's author (for replies) or the
    // post's author (for top-level comments on a post). Never self-notify.
    const me = c.get('userId')
    const preview = content.length > 120 ? `${content.slice(0, 117)}...` : content
    const commenter = result.rows[0]?.username ?? 'Someone'
    if (parentId) {
      const parentOwner = await query('SELECT user_id FROM comments WHERE id = $1', [parentId])
      const ownerId = parentOwner.rows[0]?.user_id
      if (ownerId && ownerId !== me) {
        notify(ownerId, 'replies', {
          title: `${commenter} replied to your comment`,
          body: preview,
          data: { url: postId ? `/post/${postId}` : articleId ? `/article/${articleId}` : `/debate/${debateId}` },
        })
      }
    } else if (postId) {
      const postOwner = await query('SELECT user_id FROM posts WHERE id = $1', [postId])
      const ownerId = postOwner.rows[0]?.user_id
      if (ownerId && ownerId !== me) {
        notify(ownerId, 'replies', {
          title: `${commenter} commented on your post`,
          body: preview,
          data: { url: `/post/${postId}` },
        })
      }
    }
    return c.json(result.rows[0], 201)
  } catch (err: any) {
    await client.query('ROLLBACK')
    if (err?.code === '23503') return c.json({ error: 'Post or article not found.' }, 404)
    throw err
  } finally {
    client.release()
  }
})

export default comments
