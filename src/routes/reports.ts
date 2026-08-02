import { Hono } from 'hono'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'
import { rateLimit } from '../middleware/rateLimit'
import type { AppEnv } from '../types'

const reports = new Hono<AppEnv>()

const KINDS = new Set(['post', 'article', 'comment', 'user', 'message'])
const REASONS = new Set(['spam', 'harassment', 'misinformation', 'hate', 'other'])

// POST /reports  { target_kind, target_id, reason, detail? }
// Re-reporting the same target updates the existing report instead of
// stacking duplicates — the reporter's latest reason wins.
reports.post('/', requireAuth, rateLimit({ name: 'report', windowMs: 24 * 60 * 60_000, max: 30 }), async (c) => {
  const body = await c.req.json().catch(() => null)
  const kind = String(body?.target_kind ?? '')
  const targetId = String(body?.target_id ?? '').trim()
  const reason = String(body?.reason ?? '')
  const detail = body?.detail ? String(body.detail).slice(0, 500) : null

  if (!KINDS.has(kind)) return c.json({ error: 'Invalid target_kind.' }, 400)
  if (!targetId) return c.json({ error: 'target_id is required.' }, 400)
  if (!REASONS.has(reason)) return c.json({ error: 'Invalid reason.' }, 400)

  // A private message can only be reported by its recipient. This prevents
  // arbitrary id probing and keeps the original message as the evidence the
  // admin queue reviews instead of duplicating private text into an audit log.
  if (kind === 'message') {
    const reporterId = c.get('userId')
    const message = await query(
      `SELECT 1
       FROM messages m
       JOIN conversations conv ON conv.id = m.conversation_id
       WHERE m.id::text = $1
         AND m.hidden = FALSE
         AND m.sender_id <> $2
         AND (conv.a_id = $2 OR conv.b_id = $2)
       LIMIT 1`,
      [targetId, reporterId]
    )
    if (!message.rows[0]) return c.json({ error: 'Message not found.' }, 404)
  }

  await query(
    `INSERT INTO reports (reporter_id, target_kind, target_id, reason, detail)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (reporter_id, target_kind, target_id)
     DO UPDATE SET reason = $4, detail = $5, created_at = NOW()`,
    [c.get('userId'), kind, targetId, reason, detail]
  )
  return c.json({ ok: true }, 201)
})

export default reports
