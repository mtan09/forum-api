import { Hono } from 'hono'
import pool, { query } from '../db'
import {
  AI_CONSENT_VERSION,
  currentAIConsent,
  recordAIConsent,
} from '../lib/ai-consent'
import { requireAuth } from '../middleware/auth'
import { moderateText, moderationFailure } from '../lib/moderation'
import { notify } from '../lib/push'
import type { AppEnv } from '../types'
import { articleSocialFields, postSocialFields } from '../lib/content-social'
import {
  POST_WEIGHT,
  VOTE_WEIGHT,
  decayedWeight,
  spectrumPosition,
  voteValue,
  type SpectrumEvent,
} from '../lib/spectrum'
import { mergePage, parsePagination } from '../lib/pagination'

const users = new Hono<AppEnv>()

const PUBLIC_USER_COLS = 'id, username, avatar_url, bio, header_url, is_private, is_demo, created_at'

// GET /users/me — current user's profile including email
users.get('/me', requireAuth, async (c) => {
  const result = await query(
    `SELECT u.id, u.username, u.avatar_url, u.bio, u.header_url, u.is_private, u.is_demo,
            u.created_at, u.is_admin, a.email, a.email_verified,
            COALESCE(ai.status, 'not_asked') AS ai_consent_status,
            ai.consent_version AS ai_consent_version,
            (ai.status = 'accepted' AND ai.consent_version = $2) AS ai_consent_current
     FROM userdata u
     LEFT JOIN auth_credentials a ON a.user_id = u.id
     LEFT JOIN ai_data_consents ai ON ai.user_id = u.id
     WHERE u.id = $1`,
    [c.get('userId'), AI_CONSENT_VERSION]
  )
  if (!result.rows[0]) return c.json({ error: 'User not found' }, 404)
  return c.json(result.rows[0])
})

// Explicit third-party AI permission. Reading the app never requires this.
// Declining or revoking prevents later user content from reaching OpenAI.
users.get('/me/ai-consent', requireAuth, async (c) => {
  const consent = await currentAIConsent(c.get('userId'))
  return c.json({ ...consent, consent_version: AI_CONSENT_VERSION })
})

users.put('/me/ai-consent', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null)
  if (typeof body?.accepted !== 'boolean') {
    return c.json({ error: 'accepted must be true or false.' }, 400)
  }
  const version = String(body?.consent_version ?? '')
  if (version !== AI_CONSENT_VERSION) {
    return c.json(
      {
        code: 'AI_CONSENT_VERSION_MISMATCH',
        error: 'The AI data-sharing disclosure has changed. Please review it again.',
        consent_version: AI_CONSENT_VERSION,
      },
      409
    )
  }
  const consent = await recordAIConsent(c.get('userId'), body.accepted, version)
  return c.json({ ...consent, consent_version: AI_CONSENT_VERSION })
})

// PATCH /users/me — update username, bio, avatar_url, header_url
users.patch('/me', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'Invalid body' }, 400)

  const fields: Record<string, string | boolean | null> = {}
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
  if (body.is_private !== undefined) fields.is_private = !!body.is_private
  if (Object.keys(fields).length === 0) {
    return c.json({ error: 'Nothing to update' }, 400)
  }
  for (const key of ['username', 'bio'] as const) {
    if (typeof fields[key] === 'string' && fields[key]) {
      const moderation = await moderateText(c.get('userId'), key, fields[key] as string)
      const moderationError = moderationFailure(moderation)
      if (moderationError) return c.json(moderationError.body, moderationError.status)
    }
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

// GET /users/me/spectrum — the user's single political placement. See
// lib/spectrum.ts for the model and for why the decay is floorless.
async function computeSpectrum(userId: string) {
  const [ownPosts, postVotes, articleVotes] = await Promise.all([
    query(
      'SELECT position, created_at FROM posts WHERE user_id = $1 AND position IS NOT NULL',
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

  const voteRows = [...postVotes.rows, ...articleVotes.rows]
  const events: SpectrumEvent[] = [
    ...ownPosts.rows.map((row) => ({
      at: new Date(row.created_at),
      weight: POST_WEIGHT,
      value: Number(row.position),
    })),
    ...voteRows.map((row) => ({
      at: new Date(row.created_at),
      weight: VOTE_WEIGHT,
      value: voteValue(String(row.direction), Number(row.lean)),
    })),
  ]

  return {
    position: Number(spectrumPosition(events, new Date()).toFixed(3)),
    sample: {
      posts: ownPosts.rows.length,
      upvotes: voteRows.filter((row) => row.direction === 'up').length,
      downvotes: voteRows.filter((row) => row.direction !== 'up').length,
    },
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

  // Weights are decayed against one fixed reference rather than recomputed per
  // cut. That is exact, not an approximation: at cut T every weight carries the
  // same extra factor 0.5^((T-reference)/H), which cancels in the ratio. So the
  // running accumulation below still yields the value /me/spectrum would have
  // reported at each cut.
  const reference = new Date()
  type Event = { t: number; weight: number; value: number }
  const events: Event[] = [
    ...ownPosts.rows.map((r) => ({
      t: new Date(r.created_at).getTime(),
      weight: decayedWeight(POST_WEIGHT, r.created_at, reference),
      value: Number(r.value),
    })),
    ...[...postVotes.rows, ...articleVotes.rows].map((r) => ({
      t: new Date(r.created_at).getTime(),
      weight: decayedWeight(VOTE_WEIGHT, r.created_at, reference),
      value: voteValue(String(r.direction), Number(r.lean)),
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
    `SELECT u.id, u.username, u.avatar_url, u.bio, u.is_demo,
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
            COALESCE(p.email_enabled, FALSE) AS email_enabled,
            COALESCE(p.push_replies, TRUE) AS push_replies,
            COALESCE(p.push_upvotes, TRUE) AS push_upvotes,
            COALESCE(p.push_dms, TRUE) AS push_dms,
            COALESCE(p.push_follows, TRUE) AS push_follows,
            COALESCE(p.email_replies, TRUE) AS email_replies,
            COALESCE(p.email_upvotes, FALSE) AS email_upvotes,
            COALESCE(p.email_dms, TRUE) AS email_dms,
            COALESCE(p.email_follows, FALSE) AS email_follows,
            COALESCE(p.push_replies, TRUE) AS replies,
            COALESCE(p.push_upvotes, TRUE) AS upvotes,
            COALESCE(p.push_dms, TRUE) AS dms,
            COALESCE(a.email_verified, FALSE) AS email_verified
     FROM userdata u
     LEFT JOIN notification_prefs p ON p.user_id = u.id
     LEFT JOIN auth_credentials a ON a.user_id = u.id
     WHERE u.id = $1`,
    [c.get('userId')]
  )
  return c.json(
    result.rows[0] ?? {
      push_enabled: true,
      email_enabled: false,
      push_replies: true,
      push_upvotes: true,
      push_dms: true,
      push_follows: true,
      email_replies: true,
      email_upvotes: false,
      email_dms: true,
      email_follows: false,
      replies: true,
      upvotes: true,
      dms: true,
      email_verified: false,
    }
  )
})

users.put('/me/notification-prefs', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'Invalid body' }, 400)
  if (body.email_enabled === true) {
    const verification = await query(
      'SELECT email_verified FROM auth_credentials WHERE user_id = $1',
      [c.get('userId')]
    )
    if (!verification.rows[0]?.email_verified) {
      return c.json(
        { code: 'EMAIL_NOT_VERIFIED', error: 'Verify your email before enabling email notifications.' },
        403
      )
    }
  }
  const val = (key: string) => (body[key] === undefined ? null : !!body[key])
  const legacy = (event: 'replies' | 'upvotes' | 'dms') =>
    body[`push_${event}`] === undefined ? val(event) : val(`push_${event}`)
  await query(
    `INSERT INTO notification_prefs
       (user_id, push_enabled, email_enabled, replies, upvotes, dms,
        push_replies, push_upvotes, push_dms, push_follows,
        email_replies, email_upvotes, email_dms, email_follows)
     VALUES
       ($1, COALESCE($2, TRUE), COALESCE($3, FALSE),
        COALESCE($4, TRUE), COALESCE($5, TRUE), COALESCE($6, TRUE),
        COALESCE($4, TRUE), COALESCE($5, TRUE), COALESCE($6, TRUE), COALESCE($7, TRUE),
        COALESCE($8, TRUE), COALESCE($9, FALSE), COALESCE($10, TRUE), COALESCE($11, FALSE))
     ON CONFLICT (user_id) DO UPDATE SET
       push_enabled = COALESCE($2, notification_prefs.push_enabled),
       email_enabled = COALESCE($3, notification_prefs.email_enabled),
       replies = COALESCE($4, notification_prefs.replies),
       upvotes = COALESCE($5, notification_prefs.upvotes),
       dms = COALESCE($6, notification_prefs.dms),
       push_replies = COALESCE($4, notification_prefs.push_replies),
       push_upvotes = COALESCE($5, notification_prefs.push_upvotes),
       push_dms = COALESCE($6, notification_prefs.push_dms),
       push_follows = COALESCE($7, notification_prefs.push_follows),
       email_replies = COALESCE($8, notification_prefs.email_replies),
       email_upvotes = COALESCE($9, notification_prefs.email_upvotes),
       email_dms = COALESCE($10, notification_prefs.email_dms),
       email_follows = COALESCE($11, notification_prefs.email_follows)`,
    [
      c.get('userId'),
      val('push_enabled'),
      val('email_enabled'),
      legacy('replies'),
      legacy('upvotes'),
      legacy('dms'),
      val('push_follows'),
      val('email_replies'),
      val('email_upvotes'),
      val('email_dms'),
      val('email_follows'),
    ]
  )
  return c.json({ ok: true })
})

// POST /users/:id/block — stop seeing this user's posts and comments
users.post('/:id/block', requireAuth, async (c) => {
  const targetId = c.req.param('id')
  if (targetId === c.get('userId')) {
    return c.json({ error: 'You cannot block yourself.' }, 400)
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [c.get('userId'), targetId]
    )
    await client.query(
      `DELETE FROM follows
       WHERE (follower_id = $1 AND followee_id = $2)
          OR (follower_id = $2 AND followee_id = $1)`,
      [c.get('userId'), targetId]
    )
    await client.query('COMMIT')
  } catch (err: any) {
    await client.query('ROLLBACK')
    if (err?.code === '23503') return c.json({ error: 'User not found' }, 404)
    throw err
  } finally {
    client.release()
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
    `SELECT u.id, u.username, u.avatar_url, u.bio, u.is_demo, b.created_at AS blocked_at
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
  const { limit, offset } = parsePagination(c.req.query('limit'), c.req.query('offset'))
  const result = await query(
    `SELECT p.id, p.user_id, p.content, p.media_url, p.general_topic_id, p.position,
            p.position_confidence, p.position_signals, p.scorer_version,
            p.hashtags, p.upvotes, p.downvotes, p.commentcount, p.created_at,
            u.username, u.avatar_url, u.is_demo,
            v.direction AS my_vote,
            EXISTS(SELECT 1 FROM bookmarks b WHERE b.post_id = p.id AND b.user_id = $1) AS my_bookmark,
            ${postSocialFields('p', '$1')}
     FROM posts p
     JOIN userdata u ON u.id = p.user_id
     LEFT JOIN votes v ON v.post_id = p.id AND v.user_id = $1
     WHERE p.user_id = $1 AND NOT p.hidden
     ORDER BY p.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  )
  return c.json(result.rows)
})

// GET /users/me/comments — the caller's comments with enough parent
// context (title + kind) for the profile list to link back to the thread
users.get('/me/comments', requireAuth, async (c) => {
  const { limit, offset } = parsePagination(c.req.query('limit'), c.req.query('offset'))
  const result = await query(
    `SELECT c.id, c.content, c.created_at, c.upvotes, c.downvotes,
            c.post_id, c.article_id, c.parent_comment_id,
            (SELECT count(*)::int FROM comments r WHERE r.parent_comment_id = c.id) AS reply_count,
            CASE WHEN c.article_id IS NOT NULL THEN 'article' ELSE 'post' END AS parent_kind,
            COALESCE(a.title, LEFT(p.content, 80)) AS parent_title
     FROM comments c
     LEFT JOIN posts p ON p.id = c.post_id
     LEFT JOIN articles a ON a.id = c.article_id
     WHERE c.user_id = $1
     ORDER BY c.created_at DESC
     LIMIT $2 OFFSET $3`,
    [c.get('userId'), limit, offset]
  )
  return c.json(result.rows)
})

// GET /users/me/upvoted — posts and articles the caller upvoted, newest
// vote first, in the same mixed shape as GET /bookmarks
users.get('/me/upvoted', requireAuth, async (c) => {
  const userId = c.get('userId')
  const { limit, offset } = parsePagination(c.req.query('limit'), c.req.query('offset'))
  const reach = limit + offset
  const [posts, articles] = await Promise.all([
    query(
      `SELECT p.id, p.user_id, p.content, p.media_url, p.general_topic_id, p.position,
              p.position_confidence, p.position_signals, p.scorer_version,
              p.hashtags, p.upvotes, p.downvotes, p.commentcount, p.created_at,
              u.username, u.avatar_url, u.is_demo,
              'up' AS my_vote,
              EXISTS(SELECT 1 FROM bookmarks b WHERE b.post_id = p.id AND b.user_id = $1) AS my_bookmark,
              ${postSocialFields('p', '$1')},
              v.created_at AS voted_at
       FROM votes v
       JOIN posts p ON p.id = v.post_id
       JOIN userdata u ON u.id = p.user_id
       WHERE v.user_id = $1 AND v.direction = 'up' AND NOT p.hidden
       ORDER BY v.created_at DESC
       LIMIT $2`,
      [userId, reach]
    ),
    query(
      `SELECT a.id, a.url, a.title, a.source, a.media, a.political_lean,
         a.political_relevance, a.lean_confidence, a.content_type, a.lean_signals,
         a.source_lean, a.scorer_version, a.upvotes, a.downvotes, a.commentcount,
         a.general_topic_id, a.subtopic_id, a.published_at, a.status, a.created_at,
         a.ai_context_allowed, 'up' AS my_vote,
              EXISTS(SELECT 1 FROM bookmarks b WHERE b.article_id = a.id AND b.user_id = $1) AS my_bookmark,
              ${articleSocialFields('a', '$1')},
              v.created_at AS voted_at
       FROM article_votes v
       JOIN articles a ON a.id = v.article_id
       WHERE v.user_id = $1 AND v.direction = 'up' AND a.status = 'ready'
       ORDER BY v.created_at DESC
       LIMIT $2`,
      [userId, reach]
    ),
  ])

  const items = mergePage(
    [
      ...posts.rows.map((row) => ({ kind: 'post' as const, voted_at: row.voted_at, item: row })),
      ...articles.rows.map((row) => ({ kind: 'article' as const, voted_at: row.voted_at, item: row })),
    ],
    (row) => row.voted_at,
    limit,
    offset
  )

  return c.json(items)
})

// GET /users/me/reposts — posts and articles the caller reposted, newest
// repost first, in the same mixed shape as GET /bookmarks
users.get('/me/reposts', requireAuth, async (c) => {
  const userId = c.get('userId')
  const { limit, offset } = parsePagination(c.req.query('limit'), c.req.query('offset'))
  const reach = limit + offset
  const [posts, articles] = await Promise.all([
    query(
      `SELECT p.id, p.user_id, p.content, p.media_url, p.general_topic_id, p.position,
              p.position_confidence, p.position_signals, p.scorer_version,
              p.hashtags, p.upvotes, p.downvotes, p.commentcount, p.created_at,
              u.username, u.avatar_url, u.is_demo,
              v.direction AS my_vote,
              EXISTS(SELECT 1 FROM bookmarks b WHERE b.post_id = p.id AND b.user_id = $1) AS my_bookmark,
              ${postSocialFields('p', '$1')},
              r.created_at AS reposted_at
       FROM reposts r
       JOIN posts p ON p.id = r.post_id
       JOIN userdata u ON u.id = p.user_id
       LEFT JOIN votes v ON v.post_id = p.id AND v.user_id = $1
       WHERE r.user_id = $1 AND NOT p.hidden
         AND NOT EXISTS(SELECT 1 FROM blocks bl WHERE bl.blocker_id = $1 AND bl.blocked_id = p.user_id)
       ORDER BY r.created_at DESC
       LIMIT $2`,
      [userId, reach]
    ),
    query(
      `SELECT a.id, a.url, a.title, a.source, a.media, a.political_lean,
         a.political_relevance, a.lean_confidence, a.content_type, a.lean_signals,
         a.source_lean, a.scorer_version, a.upvotes, a.downvotes, a.commentcount,
         a.general_topic_id, a.subtopic_id, a.published_at, a.status, a.created_at,
         a.ai_context_allowed, v.direction AS my_vote,
              EXISTS(SELECT 1 FROM bookmarks b WHERE b.article_id = a.id AND b.user_id = $1) AS my_bookmark,
              ${articleSocialFields('a', '$1')},
              r.created_at AS reposted_at
       FROM reposts r
       JOIN articles a ON a.id = r.article_id
       LEFT JOIN article_votes v ON v.article_id = a.id AND v.user_id = $1
       WHERE r.user_id = $1 AND a.status = 'ready'
       ORDER BY r.created_at DESC
       LIMIT $2`,
      [userId, reach]
    ),
  ])

  const items = mergePage(
    [
      ...posts.rows.map((row) => ({ kind: 'post' as const, reposted_at: row.reposted_at, item: row })),
      ...articles.rows.map((row) => ({ kind: 'article' as const, reposted_at: row.reposted_at, item: row })),
    ],
    (row) => row.reposted_at,
    limit,
    offset
  )

  return c.json(items)
})

// DELETE /users/me — permanently delete the account; posts, comments and
// votes cascade via foreign keys.
users.delete('/me', requireAuth, async (c) => {
  const userId = c.get('userId')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO deletion_jobs (deleted_user_id, public_prefix, feedback_prefix)
       VALUES ($1, $2, $3)`,
      [userId, `${userId}/`, `feedback/${userId}/`]
    )
    // Delete feedback text, device metadata, notes, and stale screenshot keys
    // immediately. The queued job above removes the screenshot bytes from the
    // private bucket independently, with retries if storage is unavailable.
    await client.query('DELETE FROM beta_feedback WHERE user_id = $1', [userId])
    await client.query('DELETE FROM userdata WHERE id = $1', [userId])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
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

// GET /users/me/follow-requests — pending requests received by a private
// account. Public accounts normally have no pending rows.
users.get('/me/follow-requests', requireAuth, async (c) => {
  const result = await query(
    `SELECT u.id, u.username, u.avatar_url, u.bio, u.is_demo, f.created_at AS requested_at
     FROM follows f
     JOIN userdata u ON u.id = f.follower_id
     WHERE f.followee_id = $1 AND f.status = 'pending'
       AND NOT EXISTS(
         SELECT 1 FROM blocks b
         WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
            OR (b.blocker_id = u.id AND b.blocked_id = $1)
       )
     ORDER BY f.created_at DESC`,
    [c.get('userId')]
  )
  return c.json(result.rows)
})

users.post('/follow-requests/:followerId/accept', requireAuth, async (c) => {
  const result = await query(
    `UPDATE follows
     SET status = 'accepted', responded_at = NOW()
     WHERE follower_id = $1 AND followee_id = $2 AND status = 'pending'
     RETURNING follower_id`,
    [c.req.param('followerId'), c.get('userId')]
  )
  if (!result.rows[0]) return c.json({ error: 'Follow request not found.' }, 404)
  const me = await query('SELECT username FROM userdata WHERE id = $1', [c.get('userId')])
  notify(result.rows[0].follower_id, 'follows', {
    title: 'Follow request accepted',
    body: `${me.rows[0]?.username ?? 'This account'} accepted your follow request.`,
    data: { url: `/user/${c.get('userId')}` },
  })
  return c.json({ ok: true, follow_status: 'accepted' })
})

users.post('/follow-requests/:followerId/decline', requireAuth, async (c) => {
  const result = await query(
    `DELETE FROM follows
     WHERE follower_id = $1 AND followee_id = $2 AND status = 'pending'
     RETURNING follower_id`,
    [c.req.param('followerId'), c.get('userId')]
  )
  if (!result.rows[0]) return c.json({ error: 'Follow request not found.' }, 404)
  return c.json({ ok: true })
})

users.delete('/followers/:followerId', requireAuth, async (c) => {
  await query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [
    c.req.param('followerId'),
    c.get('userId'),
  ])
  return c.json({ ok: true })
})

// GET /users/:id/followers · /following — accepted social connections only.
// Blocked relationships are omitted in both directions so these lists follow
// the same visibility boundary as feeds, requests, and public profiles.
users.get('/:id/followers', requireAuth, async (c) => {
  const targetId = c.req.param('id')
  const viewerId = c.get('userId')
  const exists = await query('SELECT 1 FROM userdata WHERE id = $1', [targetId])
  if (!exists.rows[0]) return c.json({ error: 'User not found' }, 404)

  const result = await query(
    `SELECT u.id, u.username, u.avatar_url, u.bio, u.header_url, u.is_private, u.is_demo, u.created_at,
            EXISTS(
              SELECT 1 FROM follows mine
              WHERE mine.follower_id = $2 AND mine.followee_id = u.id AND mine.status = 'accepted'
            ) AS followed_by_me,
            (NOT u.is_private OR EXISTS(
              SELECT 1 FROM follows allowed
              WHERE allowed.follower_id = u.id AND allowed.followee_id = $2
                AND allowed.status = 'accepted'
            )) AS can_message,
            (SELECT mine.status FROM follows mine WHERE mine.follower_id = $2 AND mine.followee_id = u.id) AS follow_status
     FROM follows f
     JOIN userdata u ON u.id = f.follower_id
     WHERE f.followee_id = $1 AND f.status = 'accepted'
       AND NOT EXISTS(
         SELECT 1 FROM blocks b
         WHERE (b.blocker_id = $2 AND b.blocked_id = u.id)
            OR (b.blocker_id = u.id AND b.blocked_id = $2)
       )
     ORDER BY LOWER(u.username), u.id`,
    [targetId, viewerId]
  )
  return c.json(result.rows)
})

users.get('/:id/following', requireAuth, async (c) => {
  const targetId = c.req.param('id')
  const viewerId = c.get('userId')
  const exists = await query('SELECT 1 FROM userdata WHERE id = $1', [targetId])
  if (!exists.rows[0]) return c.json({ error: 'User not found' }, 404)

  const result = await query(
    `SELECT u.id, u.username, u.avatar_url, u.bio, u.header_url, u.is_private, u.is_demo, u.created_at,
            EXISTS(
              SELECT 1 FROM follows mine
              WHERE mine.follower_id = $2 AND mine.followee_id = u.id AND mine.status = 'accepted'
            ) AS followed_by_me,
            (NOT u.is_private OR EXISTS(
              SELECT 1 FROM follows allowed
              WHERE allowed.follower_id = u.id AND allowed.followee_id = $2
                AND allowed.status = 'accepted'
            )) AS can_message,
            (SELECT mine.status FROM follows mine WHERE mine.follower_id = $2 AND mine.followee_id = u.id) AS follow_status
     FROM follows f
     JOIN userdata u ON u.id = f.followee_id
     WHERE f.follower_id = $1 AND f.status = 'accepted'
       AND NOT EXISTS(
         SELECT 1 FROM blocks b
         WHERE (b.blocker_id = $2 AND b.blocked_id = u.id)
            OR (b.blocker_id = u.id AND b.blocked_id = $2)
       )
     ORDER BY LOWER(u.username), u.id`,
    [targetId, viewerId]
  )
  return c.json(result.rows)
})

// GET /users/:id — public profile (+ block state, follow state, counts)
users.get('/:id', requireAuth, async (c) => {
  const result = await query(
    `SELECT ${PUBLIC_USER_COLS},
            EXISTS(SELECT 1 FROM blocks b WHERE b.blocker_id = $2 AND b.blocked_id = id) AS blocked_by_me,
            EXISTS(
              SELECT 1 FROM follows f
              WHERE f.follower_id = $2 AND f.followee_id = id AND f.status = 'accepted'
            ) AS followed_by_me,
            (SELECT f.status FROM follows f WHERE f.follower_id = $2 AND f.followee_id = id) AS follow_status,
            (NOT is_private OR EXISTS(
              SELECT 1 FROM follows f
              WHERE f.follower_id = id AND f.followee_id = $2 AND f.status = 'accepted'
            )) AS can_message,
            (id = $2 OR NOT is_private OR EXISTS(
              SELECT 1 FROM follows f
              WHERE f.follower_id = $2 AND f.followee_id = id AND f.status = 'accepted'
            )) AS can_view_history,
            (SELECT count(*)::int FROM follows f WHERE f.followee_id = id AND f.status = 'accepted') AS follower_count,
            (SELECT count(*)::int FROM follows f WHERE f.follower_id = id AND f.status = 'accepted') AS following_count
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
  const me = c.get('userId')
  if (targetId === me) return c.json({ error: "You can't follow yourself." }, 400)
  const target = await query(
    `SELECT u.is_private, u.username,
            EXISTS(
              SELECT 1 FROM blocks b
              WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                 OR (b.blocker_id = u.id AND b.blocked_id = $1)
            ) AS blocked
     FROM userdata u WHERE u.id = $2`,
    [me, targetId]
  )
  if (!target.rows[0]) return c.json({ error: 'User not found' }, 404)
  if (target.rows[0].blocked) return c.json({ error: 'You cannot follow this account.' }, 403)
  const status = target.rows[0].is_private ? 'pending' : 'accepted'
  const inserted = await query(
    `INSERT INTO follows (follower_id, followee_id, status, responded_at)
     VALUES ($1, $2, $3, CASE WHEN $3 = 'accepted' THEN NOW() ELSE NULL END)
     ON CONFLICT (follower_id, followee_id) DO UPDATE
       SET status = EXCLUDED.status,
           created_at = NOW(),
           responded_at = EXCLUDED.responded_at
     RETURNING status`,
    [me, targetId, status]
  )
  const actor = await query('SELECT username FROM userdata WHERE id = $1', [me])
  notify(targetId, 'follows', {
    title: status === 'pending' ? 'New follow request' : 'New follower',
    body: `${actor.rows[0]?.username ?? 'Someone'} ${
      status === 'pending' ? 'requested to follow you.' : 'followed you.'
    }`,
    data: { url: status === 'pending' ? '/follow-requests' : `/user/${me}` },
  })
  return c.json({ ok: true, follow_status: inserted.rows[0].status }, 201)
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
