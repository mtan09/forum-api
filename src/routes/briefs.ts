import { Hono } from 'hono'
import { query } from '../db'
import {
  generateDailyBrief,
  getDailyBrief,
  listDailyBriefs,
  markDailyBriefSeen,
  validTimezone,
} from '../lib/daily-brief'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

const briefs = new Hono<AppEnv>()
const DATE = /^\d{4}-\d{2}-\d{2}$/

briefs.get('/today', requireAuth, async (c) => {
  const supplied = c.req.query('timezone')
  const zone = supplied ? validTimezone(supplied) : null
  if (supplied && !zone) return c.json({ error: 'A valid IANA timezone is required.' }, 400)

  let timezone = zone
  if (timezone) {
    await query(
      `INSERT INTO notification_prefs (user_id, timezone)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET timezone = EXCLUDED.timezone`,
      [c.get('userId'), timezone]
    )
  } else {
    const stored = await query('SELECT timezone FROM notification_prefs WHERE user_id = $1', [c.get('userId')])
    timezone = validTimezone(stored.rows[0]?.timezone) ?? 'America/New_York'
  }

  const brief = await generateDailyBrief(c.get('userId'), timezone)
  return c.json({ ready: !!brief, brief })
})

briefs.get('/', requireAuth, async (c) => {
  const limit = Number(c.req.query('limit')) || 7
  return c.json(await listDailyBriefs(c.get('userId'), limit))
})

briefs.get('/:date', requireAuth, async (c) => {
  const date = c.req.param('date')
  if (!DATE.test(date)) return c.json({ error: 'Invalid brief date.' }, 400)
  const brief = await getDailyBrief(c.get('userId'), date)
  return brief ? c.json(brief) : c.json({ error: 'Daily Brief not found.' }, 404)
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

briefs.post('/:id/seen', requireAuth, async (c) => {
  const id = c.req.param('id')
  // Postgres raises on a malformed uuid, which surfaces as a 500 and a Sentry
  // event. Any authenticated caller could burn quota with `/briefs/abc/seen`.
  if (!UUID.test(id)) return c.json({ error: 'Daily Brief not found.' }, 404)
  const updated = await markDailyBriefSeen(c.get('userId'), id)
  return updated ? c.json({ ok: true }) : c.json({ error: 'Daily Brief not found.' }, 404)
})

export default briefs
