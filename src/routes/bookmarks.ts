import { Hono } from 'hono'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

const bookmarks = new Hono<AppEnv>()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// POST /bookmarks/toggle  { post_id } | { article_id } — save/unsave
bookmarks.post('/toggle', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null)
  const postId = typeof body?.post_id === 'string' && UUID_RE.test(body.post_id) ? body.post_id : null
  const articleId =
    typeof body?.article_id === 'string' && UUID_RE.test(body.article_id) ? body.article_id : null
  if (!postId === !articleId) {
    return c.json({ error: 'Provide exactly one of post_id or article_id.' }, 400)
  }

  const col = postId ? 'post_id' : 'article_id'
  const targetId = postId ?? articleId
  const userId = c.get('userId')

  const removed = await query(
    `DELETE FROM bookmarks WHERE user_id = $1 AND ${col} = $2 RETURNING id`,
    [userId, targetId]
  )
  if (removed.rows.length > 0) return c.json({ bookmarked: false })

  try {
    await query(
      `INSERT INTO bookmarks (user_id, ${col}) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, targetId]
    )
  } catch (err: any) {
    if (err?.code === '23503') return c.json({ error: 'Content not found.' }, 404)
    throw err
  }
  return c.json({ bookmarked: true })
})

// GET /bookmarks — the caller's saved posts and articles, newest saved
// first, each item in the same shape its feed endpoint returns.
bookmarks.get('/', requireAuth, async (c) => {
  const userId = c.get('userId')

  const [posts, articles] = await Promise.all([
    query(
      `SELECT p.id, p.user_id, p.content, p.media_url, p.general_topic_id, p.position,
              p.position_confidence, p.position_signals, p.scorer_version,
              p.hashtags, p.upvotes, p.downvotes, p.commentcount, p.created_at,
              u.username, u.avatar_url, u.is_demo,
              v.direction AS my_vote,
              TRUE AS my_bookmark,
              b.created_at AS saved_at
       FROM bookmarks b
       JOIN posts p ON p.id = b.post_id
       JOIN userdata u ON u.id = p.user_id
       LEFT JOIN votes v ON v.post_id = p.id AND v.user_id = $1
       WHERE b.user_id = $1`,
      [userId]
    ),
    query(
      `SELECT a.id, a.url, a.title, a.source, a.media, a.political_lean,
         a.political_relevance, a.lean_confidence, a.content_type, a.lean_signals,
         a.source_lean, a.scorer_version, a.upvotes, a.downvotes, a.commentcount,
         a.general_topic_id, a.subtopic_id, a.published_at, a.status, a.created_at,
         a.ai_context_allowed, v.direction AS my_vote, TRUE AS my_bookmark, b.created_at AS saved_at
       FROM bookmarks b
       JOIN articles a ON a.id = b.article_id
       LEFT JOIN article_votes v ON v.article_id = a.id AND v.user_id = $1
       WHERE b.user_id = $1`,
      [userId]
    ),
  ])

  const items = [
    ...posts.rows.map((row) => ({ kind: 'post' as const, saved_at: row.saved_at, item: row })),
    ...articles.rows.map((row) => ({ kind: 'article' as const, saved_at: row.saved_at, item: row })),
  ].sort((x, y) => new Date(y.saved_at).getTime() - new Date(x.saved_at).getTime())

  return c.json(items)
})

export default bookmarks
