import { Hono } from 'hono'
import { query } from '../db'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

const users = new Hono<AppEnv>()

const PUBLIC_USER_COLS = 'id, username, avatar_url, bio, header_url, created_at'

// GET /users/me — current user's profile including email
users.get('/me', requireAuth, async (c) => {
  const result = await query(
    `SELECT u.id, u.username, u.avatar_url, u.bio, u.header_url, u.created_at, u.is_admin, a.email, a.email_verified
     FROM userdata u
     LEFT JOIN auth_credentials a ON a.user_id = u.id
     WHERE u.id = $1`,
    [c.get('userId')]
  )
  if (!result.rows[0]) return c.json({ error: 'User not found' }, 404)
  return c.json(result.rows[0])
})

// PATCH /users/me — update username, bio, avatar_url, header_url
users.patch('/me', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'Invalid body' }, 400)

  const fields: Record<string, string | null> = {}
  if (body.username !== undefined) {
    const username = String(body.username).trim()
    if (username.length < 3 || username.length > 24) {
      return c.json({ error: 'Username must be 3–24 characters.' }, 400)
    }
    fields.username = username
  }
  for (const key of ['bio', 'avatar_url', 'header_url'] as const) {
    if (body[key] !== undefined) fields[key] = body[key] === null ? null : String(body[key])
  }
  if (Object.keys(fields).length === 0) {
    return c.json({ error: 'Nothing to update' }, 400)
  }

  const keys = Object.keys(fields)
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ')
  try {
    const result = await query(
      `UPDATE userdata SET ${sets} WHERE id = $1 RETURNING ${PUBLIC_USER_COLS}`,
      [c.get('userId'), ...keys.map((k) => fields[k])]
    )
    return c.json(result.rows[0])
  } catch (err: any) {
    if (err?.code === '23505') return c.json({ error: 'Username is already taken.' }, 409)
    throw err
  }
})

// GET /users/me/spectrum — the user's single political placement, computed
// from their actual activity (never self-declared):
//   - each of their scored posts contributes its position at weight 3
//   - each upvote contributes the voted content's lean at weight 1
//   - each downvote contributes the MIRROR of the content's lean (1 - lean)
//     at weight 1 — disagreeing with a right-leaning item is a left signal
// Votes on their own posts are excluded; unscored content contributes
// nothing. position = Σ(weight·value) / Σweight, 0.5 with no activity.
const POST_WEIGHT = 3
const VOTE_WEIGHT = 1

async function computeSpectrum(userId: string) {
  const [ownPosts, postVotes, articleVotes] = await Promise.all([
    query('SELECT position FROM posts WHERE user_id = $1 AND position IS NOT NULL', [userId]),
    query(
      `SELECT v.direction, p.position AS lean
       FROM votes v JOIN posts p ON p.id = v.post_id
       WHERE v.user_id = $1 AND p.user_id <> $1 AND p.position IS NOT NULL`,
      [userId]
    ),
    query(
      `SELECT v.direction, COALESCE(a.political_lean, a.source_lean) AS lean
       FROM article_votes v JOIN articles a ON a.id = v.article_id
       WHERE v.user_id = $1 AND COALESCE(a.political_lean, a.source_lean) IS NOT NULL`,
      [userId]
    ),
  ])

  let weightedSum = 0
  let totalWeight = 0
  let upvotes = 0
  let downvotes = 0

  for (const row of ownPosts.rows) {
    weightedSum += POST_WEIGHT * Number(row.position)
    totalWeight += POST_WEIGHT
  }
  for (const row of [...postVotes.rows, ...articleVotes.rows]) {
    const lean = Number(row.lean)
    if (row.direction === 'up') {
      weightedSum += VOTE_WEIGHT * lean
      upvotes++
    } else {
      weightedSum += VOTE_WEIGHT * (1 - lean)
      downvotes++
    }
    totalWeight += VOTE_WEIGHT
  }

  const position = totalWeight > 0 ? Number((weightedSum / totalWeight).toFixed(3)) : 0.5
  return {
    position,
    sample: { posts: ownPosts.rows.length, upvotes, downvotes },
  }
}

users.get('/me/spectrum', requireAuth, async (c) => {
  return c.json(await computeSpectrum(c.get('userId')!))
})

// GET /users/me/spectrum/history — the same number, given a time axis:
// cumulative placement as of each month-end for the last 6 months, plus
// today. Same weights as computeSpectrum, replayed in insertion order,
// so the trail is exactly where /me/spectrum would have pointed then.
users.get('/me/spectrum/history', requireAuth, async (c) => {
  const userId = c.get('userId')
  const [ownPosts, postVotes, articleVotes] = await Promise.all([
    query(
      'SELECT position AS value, created_at FROM posts WHERE user_id = $1 AND position IS NOT NULL',
      [userId]
    ),
    query(
      `SELECT v.direction, p.position AS lean, v.created_at
       FROM votes v JOIN posts p ON p.id = v.post_id
       WHERE v.user_id = $1 AND p.user_id <> $1 AND p.position IS NOT NULL`,
      [userId]
    ),
    query(
      `SELECT v.direction, COALESCE(a.political_lean, a.source_lean) AS lean, v.created_at
       FROM article_votes v JOIN articles a ON a.id = v.article_id
       WHERE v.user_id = $1 AND COALESCE(a.political_lean, a.source_lean) IS NOT NULL`,
      [userId]
    ),
  ])

  type Event = { t: number; weight: number; value: number }
  const events: Event[] = [
    ...ownPosts.rows.map((r) => ({
      t: new Date(r.created_at).getTime(),
      weight: POST_WEIGHT,
      value: Number(r.value),
    })),
    ...[...postVotes.rows, ...articleVotes.rows].map((r) => ({
      t: new Date(r.created_at).getTime(),
      weight: VOTE_WEIGHT,
      value: r.direction === 'up' ? Number(r.lean) : 1 - Number(r.lean),
    })),
  ].sort((a, b) => a.t - b.t)

  // Cut points: the last 6 month-ends, then now
  const now = new Date()
  const cuts: { label: string; t: number }[] = []
  for (let back = 6; back >= 1; back--) {
    const end = new Date(now.getFullYear(), now.getMonth() - back + 1, 1)
    cuts.push({
      label: new Date(now.getFullYear(), now.getMonth() - back, 1)
        .toLocaleDateString('en-US', { month: 'short' }),
      t: end.getTime(),
    })
  }
  cuts.push({ label: 'Now', t: now.getTime() + 1 })

  const points: { label: string; position: number; samples: number }[] = []
  let i = 0
  let weightedSum = 0
  let totalWeight = 0
  let samples = 0
  for (const cut of cuts) {
    while (i < events.length && events[i].t < cut.t) {
      weightedSum += events[i].weight * events[i].value
      totalWeight += events[i].weight
      samples++
      i++
    }
    if (samples > 0) {
      points.push({
        label: cut.label,
        position: Number((weightedSum / totalWeight).toFixed(3)),
        samples,
      })
    }
  }
  return c.json({ points })
})

// GET /users/me/suggested — accounts worth following for a brand-new user:
// the most active posters, excluding yourself and anyone you already
// follow or block. Powers the onboarding "follow some people" step.
users.get('/me/suggested', requireAuth, async (c) => {
  const result = await query(
    `SELECT u.id, u.username, u.avatar_url, u.bio,
            count(p.id)::int AS post_count
     FROM userdata u
     JOIN posts p ON p.user_id = u.id AND NOT p.hidden
     WHERE u.id <> $1
       AND NOT u.is_banned
       AND NOT EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = u.id)
       AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.blocker_id = $1 AND b.blocked_id = u.id)
     GROUP BY u.id
     ORDER BY count(p.id) DESC
     LIMIT 10`,
    [c.get('userId')]
  )
  return c.json(result.rows)
})

// POST /users/me/push-token  { token, platform } — register this device
// for push. Tokens are unique per device; re-registering just re-owns it.
users.post('/me/push-token', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null)
  const token = String(body?.token ?? '').trim()
  const platform = body?.platform ? String(body.platform) : null
  if (!token) return c.json({ error: 'token is required.' }, 400)
  await query(
    `INSERT INTO push_tokens (token, user_id, platform, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (token) DO UPDATE SET user_id = $2, platform = $3, updated_at = NOW()`,
    [token, c.get('userId'), platform]
  )
  return c.json({ ok: true }, 201)
})

// DELETE /users/me/push-token  { token } — e.g. on sign-out
users.delete('/me/push-token', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null)
  const token = String(body?.token ?? '').trim()
  if (token) {
    await query('DELETE FROM push_tokens WHERE token = $1 AND user_id = $2', [
      token,
      c.get('userId'),
    ])
  }
  return c.json({ ok: true })
})

// GET/PUT /users/me/notification-prefs — server-side switchboard that the
// push sender checks before every delivery.
users.get('/me/notification-prefs', requireAuth, async (c) => {
  const result = await query(
    `SELECT COALESCE(p.push_enabled, TRUE) AS push_enabled,
            COALESCE(p.replies, TRUE) AS replies,
            COALESCE(p.upvotes, TRUE) AS upvotes,
            COALESCE(p.dms, TRUE) AS dms
     FROM userdata u LEFT JOIN notification_prefs p ON p.user_id = u.id
     WHERE u.id = $1`,
    [c.get('userId')]
  )
  return c.json(result.rows[0] ?? { push_enabled: true, replies: true, upvotes: true, dms: true })
})

users.put('/me/notification-prefs', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'Invalid body' }, 400)
  const val = (key: string) => (body[key] === undefined ? null : !!body[key])
  await query(
    `INSERT INTO notification_prefs (user_id, push_enabled, replies, upvotes, dms)
     VALUES ($1, COALESCE($2, TRUE), COALESCE($3, TRUE), COALESCE($4, TRUE), COALESCE($5, TRUE))
     ON CONFLICT (user_id) DO UPDATE SET
       push_enabled = COALESCE($2, notification_prefs.push_enabled),
       replies      = COALESCE($3, notification_prefs.replies),
       upvotes      = COALESCE($4, notification_prefs.upvotes),
       dms          = COALESCE($5, notification_prefs.dms)`,
    [c.get('userId'), val('push_enabled'), val('replies'), val('upvotes'), val('dms')]
  )
  return c.json({ ok: true })
})

// POST /users/:id/block — stop seeing this user's posts and comments
users.post('/:id/block', requireAuth, async (c) => {
  const targetId = c.req.param('id')
  if (targetId === c.get('userId')) {
    return c.json({ error: 'You cannot block yourself.' }, 400)
  }
  try {
    await query(
      'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [c.get('userId'), targetId]
    )
  } catch (err: any) {
    if (err?.code === '23503') return c.json({ error: 'User not found' }, 404)
    throw err
  }
  return c.json({ blocked: true })
})

// DELETE /users/:id/block — unblock
users.delete('/:id/block', requireAuth, async (c) => {
  await query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [
    c.get('userId'),
    c.req.param('id'),
  ])
  return c.json({ blocked: false })
})

// GET /users/me/blocks — who the caller has blocked, newest first
users.get('/me/blocks', requireAuth, async (c) => {
  const result = await query(
    `SELECT u.id, u.username, u.avatar_url, u.bio, b.created_at AS blocked_at
     FROM blocks b JOIN userdata u ON u.id = b.blocked_id
     WHERE b.blocker_id = $1
     ORDER BY b.created_at DESC`,
    [c.get('userId')]
  )
  return c.json(result.rows)
})

// GET /users/me/posts — the caller's own posts, newest first
users.get('/me/posts', requireAuth, async (c) => {
  const userId = c.get('userId')
  const result = await query(
    `SELECT p.id, p.user_id, p.content, p.media_url, p.general_topic_id, p.position,
            p.position_confidence, p.hashtags, p.upvotes, p.downvotes, p.commentcount, p.created_at,
            u.username, u.avatar_url,
            v.direction AS my_vote,
            EXISTS(SELECT 1 FROM bookmarks b WHERE b.post_id = p.id AND b.user_id = $1) AS my_bookmark
     FROM posts p
     JOIN userdata u ON u.id = p.user_id
     LEFT JOIN votes v ON v.post_id = p.id AND v.user_id = $1
     WHERE p.user_id = $1
     ORDER BY p.created_at DESC
     LIMIT 100`,
    [userId]
  )
  return c.json(result.rows)
})

// GET /users/me/comments — the caller's comments with enough parent
// context (title + kind) for the profile list to link back to the thread
users.get('/me/comments', requireAuth, async (c) => {
  const result = await query(
    `SELECT c.id, c.content, c.created_at, c.upvotes, c.downvotes,
            c.post_id, c.article_id, c.parent_comment_id,
            CASE WHEN c.article_id IS NOT NULL THEN 'article' ELSE 'post' END AS parent_kind,
            COALESCE(a.title, LEFT(p.content, 80)) AS parent_title
     FROM comments c
     LEFT JOIN posts p ON p.id = c.post_id
     LEFT JOIN articles a ON a.id = c.article_id
     WHERE c.user_id = $1
     ORDER BY c.created_at DESC
     LIMIT 100`,
    [c.get('userId')]
  )
  return c.json(result.rows)
})

// GET /users/me/upvoted — posts and articles the caller upvoted, newest
// vote first, in the same mixed shape as GET /bookmarks
users.get('/me/upvoted', requireAuth, async (c) => {
  const userId = c.get('userId')
  const [posts, articles] = await Promise.all([
    query(
      `SELECT p.id, p.user_id, p.content, p.media_url, p.general_topic_id, p.position,
              p.position_confidence, p.hashtags, p.upvotes, p.downvotes, p.commentcount, p.created_at,
              u.username, u.avatar_url,
              'up' AS my_vote,
              EXISTS(SELECT 1 FROM bookmarks b WHERE b.post_id = p.id AND b.user_id = $1) AS my_bookmark,
              v.created_at AS voted_at
       FROM votes v
       JOIN posts p ON p.id = v.post_id
       JOIN userdata u ON u.id = p.user_id
       WHERE v.user_id = $1 AND v.direction = 'up'`,
      [userId]
    ),
    query(
      `SELECT a.id, a.url, a.title, a.source, a.content, a.media, a.political_lean,
         a.political_relevance, a.lean_confidence, a.content_type, a.lean_signals,
         a.source_lean, a.scorer_version, a.upvotes, a.downvotes, a.commentcount,
         a.general_topic_id, a.subtopic_id, a.published_at, a.status, a.created_at, 'up' AS my_vote,
              EXISTS(SELECT 1 FROM bookmarks b WHERE b.article_id = a.id AND b.user_id = $1) AS my_bookmark,
              v.created_at AS voted_at
       FROM article_votes v
       JOIN articles a ON a.id = v.article_id
       WHERE v.user_id = $1 AND v.direction = 'up'`,
      [userId]
    ),
  ])

  const items = [
    ...posts.rows.map((row) => ({ kind: 'post' as const, voted_at: row.voted_at, item: row })),
    ...articles.rows.map((row) => ({ kind: 'article' as const, voted_at: row.voted_at, item: row })),
  ].sort((x, y) => new Date(y.voted_at).getTime() - new Date(x.voted_at).getTime())

  return c.json(items)
})

// DELETE /users/me — permanently delete the account; posts, comments and
// votes cascade via foreign keys.
users.delete('/me', requireAuth, async (c) => {
  await query('DELETE FROM userdata WHERE id = $1', [c.get('userId')])
  return c.json({ ok: true })
})

// GET /users?ids=a,b,c — batch public profiles
users.get('/', requireAuth, async (c) => {
  const ids = (c.req.query('ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (ids.length === 0) return c.json([])
  const result = await query(
    `SELECT ${PUBLIC_USER_COLS} FROM userdata WHERE id = ANY($1)`,
    [ids]
  )
  return c.json(result.rows)
})

// GET /users/:id — public profile (+ block state, follow state, counts)
users.get('/:id', requireAuth, async (c) => {
  const result = await query(
    `SELECT ${PUBLIC_USER_COLS},
            EXISTS(SELECT 1 FROM blocks b WHERE b.blocker_id = $2 AND b.blocked_id = id) AS blocked_by_me,
            EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.followee_id = id) AS followed_by_me,
            (SELECT count(*)::int FROM follows f WHERE f.followee_id = id) AS follower_count,
            (SELECT count(*)::int FROM follows f WHERE f.follower_id = id) AS following_count
     FROM userdata WHERE id = $1`,
    [c.req.param('id'), c.get('userId')]
  )
  if (!result.rows[0]) return c.json({ error: 'User not found' }, 404)
  return c.json(result.rows[0])
})

// POST /users/:id/follow · DELETE /users/:id/follow — one-directional,
// idempotent both ways.
users.post('/:id/follow', requireAuth, async (c) => {
  const targetId = c.req.param('id')
  if (targetId === c.get('userId')) return c.json({ error: "You can't follow yourself." }, 400)
  const exists = await query('SELECT 1 FROM userdata WHERE id = $1', [targetId])
  if (!exists.rows[0]) return c.json({ error: 'User not found' }, 404)
  await query(
    `INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [c.get('userId'), targetId]
  )
  return c.json({ ok: true }, 201)
})

users.delete('/:id/follow', requireAuth, async (c) => {
  await query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [
    c.get('userId'),
    c.req.param('id'),
  ])
  return c.json({ ok: true })
})

// GET /users/:id/spectrum — anyone's computed placement (same math as
// /me/spectrum; positions are activity-derived and public by design).
// OTHER people's placements are cached briefly: computeSpectrum replays the
// user's whole vote history, and hot profiles get hit from every feed card.
// Your own (/me/spectrum) stays live so your actions reflect instantly.
const spectrumCache = new Map<string, { at: number; value: unknown }>()
const SPECTRUM_TTL_MS = 5 * 60_000

users.get('/:id/spectrum', requireAuth, async (c) => {
  const id = c.req.param('id')
  const cached = spectrumCache.get(id)
  if (cached && Date.now() - cached.at < SPECTRUM_TTL_MS) return c.json(cached.value)

  const exists = await query('SELECT 1 FROM userdata WHERE id = $1', [id])
  if (!exists.rows[0]) return c.json({ error: 'User not found' }, 404)
  const value = await computeSpectrum(id)
  spectrumCache.set(id, { at: Date.now(), value })
  if (spectrumCache.size > 5000) {
    // crude bound; stale entries expire on read anyway
    for (const [key, entry] of spectrumCache) {
      if (Date.now() - entry.at >= SPECTRUM_TTL_MS) spectrumCache.delete(key)
    }
  }
  return c.json(value)
})

export default users
