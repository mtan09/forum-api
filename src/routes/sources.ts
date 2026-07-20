import { Hono } from 'hono'
import { query } from '../db'
import { sourcePrior } from '../ingest/sources'
import { optionalAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

const sources = new Hono<AppEnv>()

// GET /sources/:name — everything the app knows about one outlet: its
// hand-mapped lean prior, how its articles actually score, its mix of
// reporting vs opinion, volume stats, and recent coverage.
sources.get('/:name', optionalAuth, async (c) => {
  const name = c.req.param('name')
  const userId = c.get('userId') ?? null

  const [stats, types, recent] = await Promise.all([
    query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS last7,
              avg(political_lean) AS avg_lean,
              percentile_cont(0.25) WITHIN GROUP (ORDER BY political_lean) AS p25,
              percentile_cont(0.75) WITHIN GROUP (ORDER BY political_lean) AS p75,
              min(created_at) AS first_seen
       FROM articles
       WHERE source = $1 AND status = 'ready'`,
      [name]
    ),
    query(
      `SELECT content_type, count(*)::int AS n
       FROM articles
       WHERE source = $1 AND status = 'ready' AND content_type IS NOT NULL
       GROUP BY content_type`,
      [name]
    ),
    query(
      `SELECT a.*, v.direction AS my_vote,
              EXISTS(SELECT 1 FROM bookmarks b WHERE b.article_id = a.id AND b.user_id = $1) AS my_bookmark
       FROM articles a
       LEFT JOIN article_votes v ON v.article_id = a.id AND v.user_id = $1
       WHERE a.source = $2 AND a.status = 'ready'
       ORDER BY a.published_at DESC NULLS LAST
       LIMIT 10`,
      [userId, name]
    ),
  ])

  const s = stats.rows[0]
  if (!s || s.total === 0) return c.json({ error: 'Source not found' }, 404)

  const contentTypes: Record<string, number> = {}
  for (const row of types.rows) contentTypes[row.content_type] = row.n

  return c.json({
    name,
    // prior from the curated list; outlets no longer listed fall back to
    // the lean stored on their articles
    lean: sourcePrior(name) ?? (recent.rows[0]?.source_lean != null ? Number(recent.rows[0].source_lean) : null),
    stats: {
      total: s.total,
      last7: s.last7,
      avg_lean: s.avg_lean != null ? Number(Number(s.avg_lean).toFixed(3)) : null,
      p25: s.p25 != null ? Number(Number(s.p25).toFixed(3)) : null,
      p75: s.p75 != null ? Number(Number(s.p75).toFixed(3)) : null,
      first_seen: s.first_seen,
    },
    content_types: contentTypes,
    articles: recent.rows,
  })
})

export default sources
