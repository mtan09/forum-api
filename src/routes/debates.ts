import { Hono } from 'hono'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

const debates = new Hono<AppEnv>()

// Today's debates are generated lazily, from the currently published
// story clusters:
//   biggest   — the top-scored cluster (volume × outlet variety × posts)
//   contested — the cluster with the deepest coverage from BOTH wings
//               (max of min(left articles, right articles))
//   trending  — the next top-scored clusters, up to MAX_DEBATES rooms
// Runs as a top-up: if the day has fewer rooms than the cap, missing ones
// are added. UNIQUE(debate_date, subtopic_id) + ON CONFLICT keeps it safe
// under concurrency and guarantees one room per story per day.
const MAX_DEBATES = 6

// The Floor's "day" follows the US news cycle, not the database server's
// clock. Neon runs on UTC, where CURRENT_DATE rolls over at 8pm ET —
// which would wipe the evening's rooms mid-conversation.
const APP_DAY = `(NOW() AT TIME ZONE 'America/New_York')::date`

async function ensureTodaysDebates(): Promise<void> {
  const existing = await query(
    `SELECT kind, subtopic_id FROM debates WHERE debate_date = ${APP_DAY}`
  )
  if (existing.rows.length >= MAX_DEBATES) return
  const existingKinds = new Set(existing.rows.map((r) => r.kind))
  const usedSubtopics = new Set(existing.rows.map((r) => String(r.subtopic_id)))

  const candidates = await query(
    `SELECT s.id, s.title, s.score,
            count(a.id) FILTER (WHERE COALESCE(a.political_lean, a.source_lean) < 0.4)::int AS left_n,
            count(a.id) FILTER (WHERE COALESCE(a.political_lean, a.source_lean) > 0.6)::int AS right_n
     FROM subtopics s
     JOIN articles a ON a.subtopic_id = s.id AND a.status = 'ready'
     WHERE s.cluster_key IS NOT NULL AND s.score > 0
     GROUP BY s.id, s.title, s.score
     HAVING count(a.id) >= 3`
  )

  const rows = (candidates.rows as {
    id: string; title: string; score: number; left_n: number; right_n: number
  }[]).filter((r) => !usedSubtopics.has(String(r.id)))
  if (rows.length === 0) return

  const picks: { kind: string; sub: (typeof rows)[number] }[] = []
  const taken = new Set<string>()

  if (!existingKinds.has('biggest')) {
    const biggest = [...rows].sort((a, b) => b.score - a.score)[0]
    picks.push({ kind: 'biggest', sub: biggest })
    taken.add(biggest.id)
  }
  if (!existingKinds.has('contested')) {
    const contested = rows
      .filter((r) => !taken.has(r.id))
      .sort(
        (a, b) =>
          Math.min(b.left_n, b.right_n) - Math.min(a.left_n, a.right_n) || b.score - a.score
      )[0]
    // only a real "most divided" room if both wings are actually covering it
    if (contested && Math.min(contested.left_n, contested.right_n) >= 1) {
      picks.push({ kind: 'contested', sub: contested })
      taken.add(contested.id)
    }
  }

  const slotsLeft = MAX_DEBATES - existing.rows.length - picks.length
  const trending = rows
    .filter((r) => !taken.has(r.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(slotsLeft, 0))
  for (const sub of trending) picks.push({ kind: 'trending', sub })

  for (const p of picks) {
    await query(
      `INSERT INTO debates (debate_date, kind, subtopic_id, title)
       VALUES (${APP_DAY}, $1, $2, $3)
       ON CONFLICT (debate_date, subtopic_id) DO NOTHING`,
      [p.kind, p.sub.id, p.sub.title]
    )
  }
}

const DEBATE_SELECT = `
  SELECT d.id, d.debate_date, d.kind, d.subtopic_id, d.title,
         (SELECT count(*)::int FROM debate_votes v WHERE v.debate_id = d.id) AS total_votes,
         (SELECT count(*)::int FROM comments c WHERE c.debate_id = d.id) AS comment_count,
         (SELECT v.position FROM debate_votes v WHERE v.debate_id = d.id AND v.user_id = $1) AS my_position
  FROM debates d
`

// 10-bin histogram of everyone's pins plus the median
async function distribution(debateId: string) {
  const [bins, median] = await Promise.all([
    query(
      `SELECT LEAST(floor(position * 10), 9)::int AS bin, count(*)::int AS n
       FROM debate_votes WHERE debate_id = $1 GROUP BY 1`,
      [debateId]
    ),
    query(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY position) AS median
       FROM debate_votes WHERE debate_id = $1`,
      [debateId]
    ),
  ])
  const out = Array(10).fill(0)
  for (const row of bins.rows) out[row.bin] = row.n
  return {
    bins: out,
    median: median.rows[0]?.median != null ? Number(Number(median.rows[0].median).toFixed(3)) : null,
  }
}

// GET /debates — today's debates (topped up lazily): featured kinds
// first, then trending by creation order
debates.get('/', requireAuth, async (c) => {
  await ensureTodaysDebates()
  const result = await query(
    `${DEBATE_SELECT}
     WHERE d.debate_date = ${APP_DAY}
     ORDER BY CASE d.kind WHEN 'biggest' THEN 0 WHEN 'contested' THEN 1 ELSE 2 END, d.created_at`,
    [c.get('userId')]
  )
  return c.json(result.rows)
})

// GET /debates/recap — yesterday's rooms with their final numbers: the
// closing beat for The Floor. Registered before /:id so "recap" never
// matches as an id.
debates.get('/recap', requireAuth, async (c) => {
  const result = await query(
    `${DEBATE_SELECT}
     WHERE d.debate_date = ${APP_DAY} - 1
     ORDER BY CASE d.kind WHEN 'biggest' THEN 0 WHEN 'contested' THEN 1 ELSE 2 END, d.created_at`,
    [c.get('userId')]
  )
  const rows = await Promise.all(
    result.rows.map(async (d) => ({ ...d, distribution: await distribution(d.id) }))
  )
  return c.json(rows)
})

// GET /debates/:id — one debate with the community distribution
debates.get('/:id', requireAuth, async (c) => {
  const result = await query(`${DEBATE_SELECT} WHERE d.id = $2`, [
    c.get('userId'),
    c.req.param('id'),
  ])
  const debate = result.rows[0]
  if (!debate) return c.json({ error: 'Debate not found' }, 404)
  return c.json({ ...debate, distribution: await distribution(debate.id) })
})

// POST /debates/:id/vote  { position: 0..1 } — drop (or move) your pin
debates.post('/:id/vote', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null)
  const position = Number(body?.position)
  if (!Number.isFinite(position) || position < 0 || position > 1) {
    return c.json({ error: 'position must be between 0 and 1.' }, 400)
  }

  try {
    await query(
      `INSERT INTO debate_votes (user_id, debate_id, position)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, debate_id) DO UPDATE SET position = $3, created_at = NOW()`,
      [c.get('userId'), c.req.param('id'), position]
    )
  } catch (err: any) {
    if (err?.code === '23503' || err?.code === '22P02') {
      return c.json({ error: 'Debate not found' }, 404)
    }
    throw err
  }

  return c.json({
    my_position: position,
    distribution: await distribution(c.req.param('id')),
  })
})

export default debates
