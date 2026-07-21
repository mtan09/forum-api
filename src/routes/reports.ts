import { Hono } from 'hono'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'
import { rateLimit } from '../middleware/rateLimit'
import type { AppEnv } from '../types'

const reports = new Hono<AppEnv>()

const KINDS = new Set(['post', 'article', 'comment', 'user'])
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
