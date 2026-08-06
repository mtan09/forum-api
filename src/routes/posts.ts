import { Hono } from 'hono'
import pool, { query } from '../db'
import { normalizeHashtags } from '../lib/hashtags'
import { matchTopic } from '../ingest/topics'
import { moderateText, moderationFailure } from '../lib/moderation'
import { notify } from '../lib/push'
import { requireAuth } from '../middleware/auth'
import { rateLimit } from '../middleware/rateLimit'
import { scorePost } from '../scoring/score'
import { semanticEmbedding } from '../recommendation/semantic'
import { postSocialFields } from '../lib/content-social'
import type { AppEnv } from '../types'

const posts = new Hono<AppEnv>()
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function ownedUploadKey(mediaUrl: string | null, userId: string): string | null {
  if (!mediaUrl) return null
  try {
    const parsed = new URL(mediaUrl)
    let filename: string | undefined
    const publicBase = process.env.R2_PUBLIC_URL?.replace(/\/$/, '')
    if (publicBase) {
      const base = new URL(publicBase)
      const basePath = base.pathname.replace(/\/$/, '')
      const expectedPrefix = `${basePath}/${userId}/`.replace(/\/+/g, '/')
      if (parsed.origin === base.origin && parsed.pathname.startsWith(expectedPrefix)) {
        filename = decodeURIComponent(parsed.pathname.slice(expectedPrefix.length))
      }
    }
    if (!filename) {
      const localPrefix = `/storage/files/${userId}/`
      if (parsed.pathname.startsWith(localPrefix)) {
        filename = decodeURIComponent(parsed.pathname.slice(localPrefix.length))
      }
    }
    if (!filename || !/^[\w-]+\.(?:jpe?g|png|webp|gif|heic|heif)$/i.test(filename)) return null
    return `${userId}/${filename}`
  } catch {
    return null
  }
}

const POST_SELECT = `
  SELECT p.id, p.user_id, p.content, p.media_url, p.general_topic_id, p.position,
         p.position_confidence, p.position_signals, p.scorer_version,
         p.hashtags, p.upvotes, p.downvotes, p.commentcount, p.created_at,
         u.username, u.avatar_url, u.is_demo,
         v.direction AS my_vote,
         EXISTS(SELECT 1 FROM bookmarks b WHERE b.post_id = p.id AND b.user_id = $1) AS my_bookmark,
         ${postSocialFields('p', '$1')}
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
  const viewerId = c.get('userId')

  if (authorId && authorId !== viewerId) {
    const access = await query(
      `SELECT u.is_private,
              EXISTS(
                SELECT 1 FROM follows f
                WHERE f.follower_id = $1 AND f.followee_id = u.id AND f.status = 'accepted'
              ) AS approved
       FROM userdata u WHERE u.id = $2`,
      [viewerId, authorId]
    )
    if (!access.rows[0]) return c.json({ error: 'User not found' }, 404)
    if (access.rows[0].is_private && !access.rows[0].approved) {
      return c.json(
        { code: 'PRIVATE_PROFILE', error: 'Follow this private account to view its post history.' },
        403
      )
    }
  }

  const params: unknown[] = [viewerId]
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
    conditions.push(
      `p.user_id IN (
        SELECT followee_id FROM follows
        WHERE follower_id = $1 AND status = 'accepted'
      )`
    )
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

// POST /posts  { content?, media_url?, hashtags?, quoted_post_id? | quoted_article_id? }
// Hashtags are author-selected (plus inline #tags in the text). The
// general topic is derived server-side as background metadata, and the
// spectrum position is computed by the deterministic scorer — NULL when
// the text contains no directional evidence. Client-supplied positions
// are ignored.
posts.post('/', requireAuth, rateLimit({ name: 'createPost', windowMs: 60 * 60_000, max: 30 }), async (c) => {
  const body = await c.req.json().catch(() => null)
  const content = String(body?.content ?? '').trim()
  const mediaUrl = body?.media_url ? String(body.media_url) : null
  const quotedPostId = typeof body?.quoted_post_id === 'string' && UUID_RE.test(body.quoted_post_id)
    ? body.quoted_post_id
    : null
  const quotedArticleId = typeof body?.quoted_article_id === 'string' && UUID_RE.test(body.quoted_article_id)
    ? body.quoted_article_id
    : null

  if (body?.quoted_post_id && !quotedPostId || body?.quoted_article_id && !quotedArticleId) {
    return c.json({ error: 'Invalid quoted content.' }, 400)
  }
  if (quotedPostId && quotedArticleId) {
    return c.json({ error: 'A post can quote only one post or article.' }, 400)
  }

  if (!content && !mediaUrl && !quotedPostId && !quotedArticleId) {
    return c.json({ error: 'Post needs text, an image, or quoted content.' }, 400)
  }
  if (content) {
    const moderation = await moderateText(c.get('userId'), 'post', content)
    const failure = moderationFailure(moderation)
    if (failure) return c.json(failure.body, failure.status)
  }

  let quoteGrounding = ''
  if (quotedPostId) {
    const quoted = await query(
      `SELECT p.content
       FROM posts p
       WHERE p.id = $2 AND NOT p.hidden
         AND NOT EXISTS (
           SELECT 1 FROM blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = p.user_id)
              OR (b.blocker_id = p.user_id AND b.blocked_id = $1)
         )`,
      [c.get('userId'), quotedPostId]
    )
    if (!quoted.rows[0]) return c.json({ error: 'The quoted post is unavailable.' }, 404)
    quoteGrounding = String(quoted.rows[0].content ?? '')
  } else if (quotedArticleId) {
    const quoted = await query(
      `SELECT title FROM articles WHERE id = $1 AND status = 'ready'`,
      [quotedArticleId]
    )
    if (!quoted.rows[0]) return c.json({ error: 'The quoted article is unavailable.' }, 404)
    quoteGrounding = String(quoted.rows[0].title ?? '')
  }

  const hashtags = normalizeHashtags(body?.hashtags, content)
  const score = scorePost(content)
  const recommendationText = `${content} ${quoteGrounding} ${hashtags.join(' ')}`.trim()
  const topic = await matchTopic(recommendationText)

  const inserted = await query(
    `INSERT INTO posts (user_id, content, media_url, general_topic_id, hashtags,
                        position, position_confidence, position_signals, scorer_version,
                        recommendation_embedding, quoted_post_id, quoted_article_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [
      c.get('userId'), content, mediaUrl, topic.generalTopicId, hashtags,
      score.position, score.confidence, score.signals, score.scorer_version,
      semanticEmbedding(recommendationText), quotedPostId, quotedArticleId,
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
          data: { url: `/post/${postId}`, post_id: postId },
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

// DELETE /posts/:id — authors may permanently delete their own posts.
// Related comments, votes, bookmarks, digests, and demo jobs cascade through
// foreign keys. Reports and message tombstones are handled explicitly because
// their target ids are intentionally stored as text/nullable references.
posts.delete('/:id', requireAuth, async (c) => {
  const postId = c.req.param('id')
  const userId = c.get('userId')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const existing = await client.query(
      'SELECT user_id, media_url FROM posts WHERE id = $1 FOR UPDATE',
      [postId]
    )
    const post = existing.rows[0]
    if (!post) {
      await client.query('ROLLBACK')
      return c.json({ error: 'Post not found.' }, 404)
    }
    if (post.user_id !== userId) {
      await client.query('ROLLBACK')
      return c.json({ error: 'You can only delete your own posts.' }, 403)
    }

    await client.query(
      `UPDATE messages
       SET content = 'This shared post is no longer available.'
       WHERE shared_post_id = $1`,
      [postId]
    )
    await client.query(
      `DELETE FROM reports
       WHERE (target_kind = 'post' AND target_id = $1::text)
          OR (target_kind = 'comment' AND target_id IN (
            SELECT id::text FROM comments WHERE post_id = $1::uuid
          ))`,
      [postId]
    )

    const objectKey = ownedUploadKey(post.media_url ?? null, userId)
    if (objectKey) {
      await client.query(
        `INSERT INTO media_deletion_jobs (object_key)
         VALUES ($1)
         ON CONFLICT (object_key) DO UPDATE SET
           status = 'pending', next_attempt_at = NOW(), updated_at = NOW(), last_error = NULL`,
        [objectKey]
      )
    }

    await client.query('DELETE FROM posts WHERE id = $1', [postId])
    await client.query('COMMIT')
    return c.json({ deleted: true, id: postId })
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
})

export default posts
