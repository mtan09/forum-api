import { Hono } from 'hono'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

// The report review pipeline — the "someone actually looks at reports"
// half of UGC moderation that App Store review expects. Admin-only.
const admin = new Hono<AppEnv>()

admin.use('*', requireAuth, async (c, next) => {
  const result = await query('SELECT is_admin FROM userdata WHERE id = $1', [c.get('userId')])
  if (!result.rows[0]?.is_admin) return c.json({ error: 'Admin only' }, 403)
  await next()
})

// GET /admin/reports?status=open — reports with reporter + a content
// preview resolved per target kind.
admin.get('/reports', async (c) => {
  const status = c.req.query('status') ?? 'open'
  const result = await query(
    `SELECT r.id, r.target_kind, r.target_id, r.reason, r.detail, r.status, r.created_at,
            reporter.username AS reporter_username,
            CASE r.target_kind
              WHEN 'post'    THEN (SELECT left(p.content, 200) FROM posts p WHERE p.id::text = r.target_id)
              WHEN 'comment' THEN (SELECT left(cm.content, 200) FROM comments cm WHERE cm.id::text = r.target_id)
              WHEN 'article' THEN (SELECT a.title FROM articles a WHERE a.id::text = r.target_id)
              WHEN 'user'    THEN (SELECT u.username FROM userdata u WHERE u.id = r.target_id)
            END AS target_preview,
            CASE r.target_kind
              WHEN 'post'    THEN (SELECT u.username FROM posts p JOIN userdata u ON u.id = p.user_id WHERE p.id::text = r.target_id)
              WHEN 'comment' THEN (SELECT u.username FROM comments cm JOIN userdata u ON u.id = cm.user_id WHERE cm.id::text = r.target_id)
              WHEN 'article' THEN (SELECT a.source FROM articles a WHERE a.id::text = r.target_id)
              WHEN 'user'    THEN (SELECT u.username FROM userdata u WHERE u.id = r.target_id)
            END AS target_author
     FROM reports r
     JOIN userdata reporter ON reporter.id = r.reporter_id
     WHERE r.status = $1
     ORDER BY r.created_at DESC
     LIMIT 100`,
    [status]
  )
  return c.json(result.rows)
})

// POST /admin/reports/:id/resolve  { action: 'hide' | 'ban' | 'dismiss' }
//   hide    — hide the reported post/comment (vanishes from all reads)
//   ban     — ban the author (or the reported user); their token stops working
//   dismiss — no action, close the report
admin.post('/reports/:id/resolve', async (c) => {
  const body = await c.req.json().catch(() => null)
  const action = String(body?.action ?? '')
  if (!['hide', 'ban', 'dismiss'].includes(action)) {
    return c.json({ error: "action must be 'hide', 'ban', or 'dismiss'." }, 400)
  }

  const report = await query('SELECT target_kind, target_id FROM reports WHERE id = $1', [
    c.req.param('id'),
  ])
  const row = report.rows[0]
  if (!row) return c.json({ error: 'Report not found' }, 404)

  if (action === 'hide') {
    if (row.target_kind === 'post') {
      await query('UPDATE posts SET hidden = TRUE WHERE id::text = $1', [row.target_id])
    } else if (row.target_kind === 'comment') {
      await query('UPDATE comments SET hidden = TRUE WHERE id::text = $1', [row.target_id])
    } else {
      return c.json({ error: `Hide is not applicable to ${row.target_kind} reports.` }, 400)
    }
  } else if (action === 'ban') {
    const authorId =
      row.target_kind === 'user'
        ? row.target_id
        : row.target_kind === 'post'
          ? (await query('SELECT user_id FROM posts WHERE id::text = $1', [row.target_id])).rows[0]?.user_id
          : row.target_kind === 'comment'
            ? (await query('SELECT user_id FROM comments WHERE id::text = $1', [row.target_id])).rows[0]?.user_id
            : null
    if (!authorId) return c.json({ error: 'No user to ban for this report.' }, 400)
    await query('UPDATE userdata SET is_banned = TRUE WHERE id = $1', [authorId])
  }

  const status = action === 'dismiss' ? 'dismissed' : 'resolved'
  await query(
    `UPDATE reports SET status = $2, resolved_by = $3, resolved_at = NOW() WHERE id = $1`,
    [c.req.param('id'), status, c.get('userId')]
  )
  return c.json({ ok: true, action })
})

export default admin
