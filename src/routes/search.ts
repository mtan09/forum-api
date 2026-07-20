import { Hono } from 'hono'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

const search = new Hono<AppEnv>()

// GET /search?q=... — one query across everything findable: users,
// outlets, posts (text or #hashtag), and articles. Sections capped small;
// this is a finder, not a browse surface.
search.get('/', requireAuth, async (c) => {
  const q = String(c.req.query('q') ?? '').trim()
  if (q.length < 2) return c.json({ users: [], sources: [], posts: [], articles: [] })

  const userId = c.get('userId')
  const like = `%${q.replace(/[%_]/g, '\\$&')}%`
  // "#tag" (or a bare word) also matches the hashtag taxonomy
  const tag = q.replace(/^#/, '').toLowerCase().replace(/[^a-z0-9_]/g, '')

  const [users, sources, posts, articles] = await Promise.all([
    query(
      `SELECT id, username, avatar_url, bio FROM userdata
       WHERE username ILIKE $1
         AND NOT EXISTS(SELECT 1 FROM blocks bl WHERE bl.blocker_id = $2 AND bl.blocked_id = id)
       ORDER BY username LIMIT 5`,
      [like, userId]
    ),
    query(
      `SELECT source AS name, max(source_lean) AS lean, count(*)::int AS articles
       FROM articles WHERE status = 'ready' AND source ILIKE $1
       GROUP BY source ORDER BY count(*) DESC LIMIT 5`,
      [like]
    ),
    query(
      `SELECT p.id, p.user_id, p.content, p.media_url, p.general_topic_id, p.position,
              p.hashtags, p.upvotes, p.downvotes, p.commentcount, p.created_at,
              u.username, u.avatar_url,
              v.direction AS my_vote,
              EXISTS(SELECT 1 FROM bookmarks b WHERE b.post_id = p.id AND b.user_id = $1) AS my_bookmark
       FROM posts p
       JOIN userdata u ON u.id = p.user_id
       LEFT JOIN votes v ON v.post_id = p.id AND v.user_id = $1
       WHERE (p.content ILIKE $2 ${tag ? 'OR $3 = ANY(p.hashtags)' : ''})
         AND NOT EXISTS(SELECT 1 FROM blocks bl WHERE bl.blocker_id = $1 AND bl.blocked_id = p.user_id)
       ORDER BY p.created_at DESC LIMIT 5`,
      tag ? [userId, like, tag] : [userId, like]
    ),
    query(
      `SELECT a.*, v.direction AS my_vote,
              EXISTS(SELECT 1 FROM bookmarks b WHERE b.article_id = a.id AND b.user_id = $1) AS my_bookmark
       FROM articles a
       LEFT JOIN article_votes v ON v.article_id = a.id AND v.user_id = $1
       WHERE a.status = 'ready' AND (a.title ILIKE $2 ${tag ? 'OR $3 = ANY(a.hashtags)' : ''})
       ORDER BY a.published_at DESC NULLS LAST LIMIT 5`,
      tag ? [userId, like, tag] : [userId, like]
    ),
  ])

  return c.json({
    users: users.rows,
    sources: sources.rows,
    posts: posts.rows,
    articles: articles.rows,
  })
})

export default search
