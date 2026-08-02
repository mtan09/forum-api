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
import { INTEREST_CATALOG, validInterestKeys } from '../recommendation/semantic'
import type { AppEnv } from '../types'

const feed = new Hono<AppEnv>()
const ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EVENT_TYPES = new Set(['impression', 'dwell', 'open', 'outbound_open'])

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
