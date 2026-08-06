import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import pool, { query } from '../db'
import { requireAuth } from '../middleware/auth'
import { rateLimit } from '../middleware/rateLimit'
import {
  personalizedFeed,
  parseContentPreference,
  parseFeedMode,
} from '../recommendation/service'
import { FEED_ALGORITHM_VERSION } from '../recommendation/rank'
import { articleSocialFields, postSocialFields } from '../lib/content-social'
import { INTEREST_CATALOG, validInterestKeys } from '../recommendation/semantic'
import type { AppEnv } from '../types'

const feed = new Hono<AppEnv>()
const ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EVENT_TYPES = new Set(['impression', 'dwell', 'open', 'outbound_open'])

// GET /feed/following?limit=20&offset=0 — a strictly chronological feed of
// the people you follow: posts they wrote, plus posts and articles they
// reposted. Reposts sort by when they were reposted, not when the original
// was published, so a follower sees them as a fresh event.
//
// Unlike GET /feed this applies no ranking. Items carry the same
// reposted_by_* attribution fields the personalized feed uses, so the client
// renders both through one path.
feed.get('/following', requireAuth, async (c) => {
  const userId = c.get('userId')
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 50)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)

  const followees = `
    SELECT followee_id FROM follows
    WHERE follower_id = $1 AND status = 'accepted'
  `
  // A reposter the caller has blocked (either direction) never attributes.
  const notBlockedWith = (column: string) => `NOT EXISTS(
    SELECT 1 FROM blocks bl
    WHERE (bl.blocker_id = $1 AND bl.blocked_id = ${column})
       OR (bl.blocker_id = ${column} AND bl.blocked_id = $1)
  )`

  const [posts, articles] = await Promise.all([
    query(
      `WITH sources AS (
         SELECT p.id, p.created_at AS sort_at,
                NULL::text AS reposter_id, NULL::timestamptz AS reposted_at
         FROM posts p
         WHERE p.user_id IN (${followees}) AND NOT p.hidden
         UNION ALL
         SELECT r.post_id, r.created_at, r.user_id, r.created_at
         FROM reposts r
         JOIN posts p ON p.id = r.post_id
         WHERE r.user_id IN (${followees}) AND r.user_id <> $1
           AND r.post_id IS NOT NULL AND NOT p.hidden
       ),
       ranked AS (
         SELECT DISTINCT ON (id) id, sort_at, reposter_id, reposted_at
         FROM sources ORDER BY id, sort_at DESC
       )
       SELECT p.id, p.user_id, p.content, p.media_url, p.general_topic_id, p.position,
              p.position_confidence, p.position_signals, p.scorer_version,
              p.hashtags, p.upvotes, p.downvotes, p.commentcount, p.created_at,
              u.username, u.avatar_url, u.is_demo,
              v.direction AS my_vote,
              EXISTS(SELECT 1 FROM bookmarks b WHERE b.post_id = p.id AND b.user_id = $1) AS my_bookmark,
              ${postSocialFields('p', '$1')},
              ranked.sort_at,
              reposter.id AS reposted_by_user_id,
              reposter.username AS reposted_by_username,
              reposter.avatar_url AS reposted_by_avatar_url,
              reposter.is_demo AS reposted_by_is_demo,
              ranked.reposted_at
       FROM ranked
       JOIN posts p ON p.id = ranked.id
       JOIN userdata u ON u.id = p.user_id
       LEFT JOIN votes v ON v.post_id = p.id AND v.user_id = $1
       LEFT JOIN userdata reposter ON reposter.id = ranked.reposter_id
       WHERE ${notBlockedWith('p.user_id')}
         AND (ranked.reposter_id IS NULL OR ${notBlockedWith('ranked.reposter_id')})
       ORDER BY ranked.sort_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit + offset, 0]
    ),
    query(
      `WITH ranked AS (
         SELECT DISTINCT ON (r.article_id) r.article_id AS id, r.created_at AS sort_at,
                r.user_id AS reposter_id, r.created_at AS reposted_at
         FROM reposts r
         WHERE r.user_id IN (${followees}) AND r.user_id <> $1 AND r.article_id IS NOT NULL
         ORDER BY r.article_id, r.created_at DESC
       )
       SELECT ${'a.id, a.url, a.title, a.source, a.media, a.political_lean, a.political_relevance, a.lean_confidence, a.content_type, a.lean_signals, a.source_lean, a.scorer_version, a.upvotes, a.downvotes, a.commentcount, a.general_topic_id, a.subtopic_id, a.published_at, a.status, a.created_at, a.ai_context_allowed'},
              v.direction AS my_vote,
              EXISTS(SELECT 1 FROM bookmarks b WHERE b.article_id = a.id AND b.user_id = $1) AS my_bookmark,
              ${articleSocialFields('a', '$1')},
              ranked.sort_at,
              reposter.id AS reposted_by_user_id,
              reposter.username AS reposted_by_username,
              reposter.avatar_url AS reposted_by_avatar_url,
              reposter.is_demo AS reposted_by_is_demo,
              ranked.reposted_at
       FROM ranked
       JOIN articles a ON a.id = ranked.id AND a.status = 'ready'
       LEFT JOIN article_votes v ON v.article_id = a.id AND v.user_id = $1
       JOIN userdata reposter ON reposter.id = ranked.reposter_id
       WHERE ${notBlockedWith('ranked.reposter_id')}
       ORDER BY ranked.sort_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit + offset, 0]
    ),
  ])

  const items = [
    ...posts.rows.map((data) => ({ kind: 'post' as const, sort_at: data.sort_at, data })),
    ...articles.rows.map((data) => ({ kind: 'article' as const, sort_at: data.sort_at, data })),
  ]
    .sort((x, y) => new Date(y.sort_at).getTime() - new Date(x.sort_at).getTime())
    .slice(offset, offset + limit)
    .map(({ kind, data }) => ({ kind, data }))

  return c.json(items)
})

feed.get('/', requireAuth, async (c) => {
  const mode = parseFeedMode(c.req.query('mode'))
  const content = parseContentPreference(c.req.query('content'))
  if (!mode || !content) return c.json({ error: 'Invalid feed mode or content preference.' }, 400)
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 40)
  try {
    return c.json(await personalizedFeed({
      userId: c.get('userId'),
      mode,
      content,
      limit,
      cursor: c.req.query('cursor'),
      requestedSessionId: c.req.query('session_id'),
    }))
  } catch (error: any) {
    if (error?.message === 'INVALID_FEED_CURSOR') {
      return c.json({ error: 'This feed session expired. Refresh to start a new one.' }, 400)
    }
    throw error
  }
})

feed.post(
  '/events',
  requireAuth,
  rateLimit({ name: 'feedEvents', windowMs: 60_000, max: 120 }),
  async (c) => {
    const body = await c.req.json().catch(() => null)
    const events = Array.isArray(body?.events) ? body.events.slice(0, 50) : []
    if (events.length === 0) return c.json({ error: 'At least one feed event is required.' }, 400)

    const valid = events.filter((event: any) =>
      typeof event?.event_id === 'string' && event.event_id.length <= 160 &&
      typeof event?.session_id === 'string' && event.session_id.length <= 120 &&
      (event?.feed_mode === 'for_you' || event?.feed_mode === 'random' || event?.feed_mode === 'against') &&
      (event?.item_type === 'post' || event?.item_type === 'article') &&
      ITEM_ID.test(String(event?.item_id ?? '')) &&
      EVENT_TYPES.has(event?.event_type)
    )
    if (valid.length !== events.length) return c.json({ error: 'One or more feed events are invalid.' }, 400)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const event of valid) {
        await client.query(
          `INSERT INTO feed_events
             (event_id, user_id, session_id, algorithm_version, feed_mode,
              item_type, item_id, event_type, position, dwell_ms, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (event_id) DO NOTHING`,
          [
            event.event_id,
            c.get('userId'),
            event.session_id,
            String(event.algorithm_version ?? FEED_ALGORITHM_VERSION).slice(0, 80),
            event.feed_mode,
            event.item_type,
            event.item_id,
            event.event_type,
            Number.isInteger(event.position) && event.position >= 0 ? event.position : null,
            event.event_type === 'dwell'
              ? Math.min(10 * 60_000, Math.max(0, Number(event.dwell_ms) || 0))
              : null,
            event.metadata && typeof event.metadata === 'object' ? event.metadata : {},
          ]
        )
      }
      await client.query('COMMIT')
      return c.json({ accepted: valid.length }, 202)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
)

feed.post('/not-interested', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null)
  const itemType = body?.item_type
  const itemId = String(body?.item_id ?? '')
  if ((itemType !== 'post' && itemType !== 'article') || !ITEM_ID.test(itemId)) {
    return c.json({ error: 'Invalid feed item.' }, 400)
  }
  const sessionId = String(body?.session_id ?? 'menu').slice(0, 120)
  const feedMode = parseFeedMode(body?.feed_mode) ?? 'random'
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO content_preferences (user_id, item_type, item_id, preference)
       VALUES ($1,$2,$3,'not_interested')
       ON CONFLICT (user_id, item_type, item_id)
       DO UPDATE SET preference = 'not_interested', created_at = NOW()`,
      [c.get('userId'), itemType, itemId]
    )
    await client.query(
      `INSERT INTO feed_events
         (event_id, user_id, session_id, algorithm_version, feed_mode,
          item_type, item_id, event_type, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'not_interested',$8)`,
      [
        randomUUID(), c.get('userId'), sessionId, FEED_ALGORITHM_VERSION,
        feedMode, itemType, itemId, { source: 'overflow_menu' },
      ]
    )
    await client.query('COMMIT')
    return c.json({ hidden: true })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

feed.get('/interests/catalog', requireAuth, (c) => c.json(INTEREST_CATALOG.map(({ terms, topicSlugs, ...publicInterest }) => publicInterest)))

feed.get('/interests', requireAuth, async (c) => {
  const result = await query(
    'SELECT interest_key, weight FROM user_interests WHERE user_id = $1 ORDER BY created_at',
    [c.get('userId')]
  )
  return c.json(result.rows)
})

feed.put('/interests', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null)
  const interests = validInterestKeys(body?.interests)
  if (Array.isArray(body?.interests) && interests.length !== new Set(body.interests.map(String)).size) {
    return c.json({ error: 'One or more interests are invalid.' }, 400)
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM user_interests WHERE user_id = $1', [c.get('userId')])
    for (const key of interests) {
      await client.query(
        'INSERT INTO user_interests (user_id, interest_key) VALUES ($1,$2)',
        [c.get('userId'), key]
      )
    }
    await client.query('COMMIT')
    return c.json({ interests })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

feed.delete('/personalization', requireAuth, async (c) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM feed_events WHERE user_id = $1', [c.get('userId')])
    await client.query('DELETE FROM content_preferences WHERE user_id = $1', [c.get('userId')])
    await client.query('DELETE FROM user_interests WHERE user_id = $1', [c.get('userId')])
    await client.query('COMMIT')
    return c.json({ reset: true })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

export default feed
