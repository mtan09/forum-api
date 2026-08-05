import { Hono } from 'hono'
import { query } from '../db'
import { signedFeedbackUrl } from '../lib/r2'
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
              WHEN 'message' THEN (SELECT left(m.content, 200) FROM messages m WHERE m.id::text = r.target_id)
            END AS target_preview,
            CASE r.target_kind
              WHEN 'post'    THEN (SELECT u.username FROM posts p JOIN userdata u ON u.id = p.user_id WHERE p.id::text = r.target_id)
              WHEN 'comment' THEN (SELECT u.username FROM comments cm JOIN userdata u ON u.id = cm.user_id WHERE cm.id::text = r.target_id)
              WHEN 'article' THEN (SELECT a.source FROM articles a WHERE a.id::text = r.target_id)
              WHEN 'user'    THEN (SELECT u.username FROM userdata u WHERE u.id = r.target_id)
              WHEN 'message' THEN (SELECT u.username FROM messages m JOIN userdata u ON u.id = m.sender_id WHERE m.id::text = r.target_id)
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
//   hide    — hide the reported post/comment/message (vanishes from all reads)
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
    } else if (row.target_kind === 'message') {
      await query('UPDATE messages SET hidden = TRUE WHERE id::text = $1', [row.target_id])
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
            : row.target_kind === 'message'
              ? (await query('SELECT sender_id FROM messages WHERE id::text = $1', [row.target_id])).rows[0]?.sender_id
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

// Structured feedback queue. Screenshot URLs are minted only for an
// authenticated admin and expire after five minutes.
admin.get('/feedback', async (c) => {
  const status = c.req.query('status') ?? 'open'
  if (!['open', 'planned', 'resolved', 'dismissed'].includes(status)) {
    return c.json({ error: 'Invalid feedback status.' }, 400)
  }
  const result = await query(
    `SELECT f.*, u.username
     FROM beta_feedback f
     LEFT JOIN userdata u ON u.id = f.user_id
     WHERE f.status = $1
     ORDER BY f.created_at DESC
     LIMIT 200`,
    [status]
  )
  return c.json(result.rows)
})

admin.patch('/feedback/:id', async (c) => {
  const body = await c.req.json().catch(() => null)
  const status = body?.status === undefined ? null : String(body.status)
  const notes = body?.admin_notes === undefined ? null : String(body.admin_notes).slice(0, 5000)
  if (status && !['open', 'planned', 'resolved', 'dismissed'].includes(status)) {
    return c.json({ error: 'Invalid feedback status.' }, 400)
  }
  const result = await query(
    `UPDATE beta_feedback
     SET status = COALESCE($2, status),
         admin_notes = COALESCE($3, admin_notes),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [c.req.param('id'), status, notes]
  )
  if (!result.rows[0]) return c.json({ error: 'Feedback not found.' }, 404)
  return c.json(result.rows[0])
})

admin.get('/feedback/:id/screenshot', async (c) => {
  const result = await query('SELECT screenshot_key FROM beta_feedback WHERE id = $1', [
    c.req.param('id'),
  ])
  const key = result.rows[0]?.screenshot_key
  if (!key) return c.json({ error: 'Screenshot not found.' }, 404)
  try {
    return c.json({ url: await signedFeedbackUrl(key, 300), expires_in: 300 })
  } catch {
    return c.json({ error: 'Private screenshot storage is unavailable.' }, 503)
  }
})

admin.get('/moderation/review', async (c) => {
  const result = await query(
    `SELECT m.id, m.surface, m.provider, m.model, m.categories,
            m.target_kind, m.target_id, m.created_at,
            CASE m.target_kind
              WHEN 'post' THEN (SELECT left(p.content, 300) FROM posts p WHERE p.id::text = m.target_id)
              WHEN 'comment' THEN (SELECT left(cm.content, 300) FROM comments cm WHERE cm.id::text = m.target_id)
              WHEN 'dm' THEN '[private message — content not retained in moderation audit]'
            END AS target_preview
     FROM moderation_audits m
     WHERE m.decision = 'review'
     ORDER BY m.created_at DESC
     LIMIT 200`
  )
  return c.json(result.rows)
})

admin.post('/moderation/:id/resolve', async (c) => {
  const body = await c.req.json().catch(() => null)
  const action = String(body?.action ?? '')
  if (!['keep', 'hide'].includes(action)) {
    return c.json({ error: "action must be 'keep' or 'hide'." }, 400)
  }
  const audit = await query(
    `SELECT target_kind, target_id FROM moderation_audits
     WHERE id = $1 AND decision = 'review'`,
    [c.req.param('id')]
  )
  const row = audit.rows[0]
  if (!row) return c.json({ error: 'Moderation review not found.' }, 404)
  if (action === 'hide') {
    if (row.target_kind === 'post') {
      await query('UPDATE posts SET hidden = TRUE WHERE id::text = $1', [row.target_id])
    } else if (row.target_kind === 'comment') {
      await query('UPDATE comments SET hidden = TRUE WHERE id::text = $1', [row.target_id])
    } else {
      return c.json({ error: 'This review target cannot be hidden automatically.' }, 400)
    }
  }
  await query(
    `UPDATE moderation_audits SET decision = $2 WHERE id = $1`,
    [c.req.param('id'), action === 'hide' ? 'reject' : 'allow']
  )
  return c.json({ ok: true, action })
})

admin.get('/ingest-status', async (c) => {
  const result = await query(
    `SELECT id, status, feeds_ok, feeds_failed, sources_failed, seen, inserted,
            skipped_duplicate, skipped_irrelevant, error, started_at,
            completed_at, duration_ms
     FROM ingest_runs
     ORDER BY started_at DESC
     LIMIT 30`
  )
  const latestSuccess = await query(
    `SELECT completed_at FROM ingest_runs
     WHERE status IN ('success', 'partial') AND completed_at IS NOT NULL
     ORDER BY completed_at DESC LIMIT 1`
  )
  return c.json({
    runs: result.rows,
    last_success_at: latestSuccess.rows[0]?.completed_at ?? null,
  })
})

// Visibility for the temporary prelaunch community worker. This never exposes
// generated text or reviewer credentials; it only shows operational counts.
admin.get('/demo-activity-status', async (c) => {
  const [accounts, jobs, kinds, recent] = await Promise.all([
    query('SELECT count(*)::int AS count FROM userdata WHERE is_demo = TRUE'),
    query(
      `SELECT status, count(*)::int AS count
       FROM demo_activity_jobs GROUP BY status ORDER BY status`
    ),
    query(
      `SELECT kind, status, count(*)::int AS count,
              count(*) FILTER (
                WHERE status = 'queued' AND scheduled_for <= NOW()
              )::int AS overdue
       FROM demo_activity_jobs
       GROUP BY kind, status
       ORDER BY kind, status`
    ),
    query(
      `SELECT id, kind, status, scheduled_for, executed_at, attempts, last_error
       FROM demo_activity_jobs
       ORDER BY COALESCE(executed_at, scheduled_for) DESC
       LIMIT 30`
    ),
  ])
  return c.json({
    enabled: process.env.DEMO_ACTIVITY_ENABLED === 'yes',
    demo_accounts: Number(accounts.rows[0]?.count ?? 0),
    jobs: Object.fromEntries(jobs.rows.map((row) => [row.status, Number(row.count)])),
    jobs_by_kind: kinds.rows.map((row) => ({
      kind: row.kind,
      status: row.status,
      count: Number(row.count),
      overdue: Number(row.overdue),
    })),
    recent: recent.rows,
  })
})

export default admin
