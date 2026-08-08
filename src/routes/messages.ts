import { Hono } from 'hono'
import pool, { query } from '../db'
import { notify } from '../lib/push'
import { dmPath } from '../lib/notification-routes'
import { moderateText, moderationFailure } from '../lib/moderation'
import { requireAuth } from '../middleware/auth'
import { rateLimit } from '../middleware/rateLimit'
import type { AppEnv } from '../types'

const messages = new Hono<AppEnv>()
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type SharedKind = 'post' | 'article'

async function sharedPreview(kind: SharedKind, id: string, senderId: string, recipientId: string) {
  if (kind === 'post') {
    const result = await query(
      `SELECT jsonb_build_object(
                'kind', 'post',
                'id', p.id,
                'text', p.content,
                'media_url', p.media_url,
                'position', p.position,
                'author_id', p.user_id,
                'author_name', u.username,
                'author_avatar_url', u.avatar_url,
                'author_is_demo', u.is_demo
              ) AS shared
       FROM posts p
       JOIN userdata u ON u.id = p.user_id
       WHERE p.id = $1 AND NOT p.hidden
         AND NOT EXISTS(
           SELECT 1 FROM blocks bl
           WHERE (bl.blocker_id IN ($2, $3) AND bl.blocked_id = p.user_id)
              OR (bl.blocker_id = p.user_id AND bl.blocked_id IN ($2, $3))
         )`,
      [id, senderId, recipientId]
    )
    return result.rows[0]?.shared ?? null
  }

  const result = await query(
    `SELECT jsonb_build_object(
              'kind', 'article',
              'id', a.id,
              'title', a.title,
              'source', a.source,
              'media_url', a.media,
              'political_lean', a.political_lean,
              'source_lean', a.source_lean,
              'published_at', a.published_at
            ) AS shared
     FROM articles a
     WHERE a.id = $1 AND a.status = 'ready'`,
    [id]
  )
  return result.rows[0]?.shared ?? null
}

// Conversations are keyed by the sorted user pair, so "the conversation
// with user X" is always unique regardless of who messaged first. Client
// screens address threads by the OTHER user's id, never by conversation id.
const sortPair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x])

// GET /messages — the inbox: every conversation, newest activity first,
// with the other participant, last message preview, and unread count.
messages.get('/', requireAuth, async (c) => {
  const me = c.get('userId')
  const result = await query(
    `SELECT conv.id AS conversation_id,
            other.id AS user_id, other.username, other.avatar_url, other.is_demo,
            (NOT other.is_private OR EXISTS(
              SELECT 1 FROM follows f
              WHERE f.follower_id = other.id AND f.followee_id = $1 AND f.status = 'accepted'
            )) AS can_message,
            conv.last_message_at,
            CASE WHEN lm.shared_post_id IS NOT NULL THEN 'Shared a post'
                 WHEN lm.shared_article_id IS NOT NULL THEN 'Shared an article'
                 ELSE NULLIF(lm.content, '')
            END AS last_message,
            CASE WHEN lm.shared_post_id IS NOT NULL THEN 'post'
                 WHEN lm.shared_article_id IS NOT NULL THEN 'article'
            END AS last_message_kind,
            lm.sender_id AS last_sender_id,
            (SELECT count(*)::int FROM messages m
             WHERE m.conversation_id = conv.id
               AND m.sender_id <> $1
               AND m.hidden = FALSE
               AND m.created_at > COALESCE(r.last_read_at, 'epoch')) AS unread
     FROM conversations conv
     JOIN userdata other ON other.id = CASE WHEN conv.a_id = $1 THEN conv.b_id ELSE conv.a_id END
     LEFT JOIN conversation_reads r ON r.conversation_id = conv.id AND r.user_id = $1
     LEFT JOIN LATERAL (
       SELECT content, sender_id, shared_post_id, shared_article_id FROM messages m
       WHERE m.conversation_id = conv.id AND m.hidden = FALSE
       ORDER BY m.created_at DESC LIMIT 1
     ) lm ON TRUE
     WHERE (conv.a_id = $1 OR conv.b_id = $1)
       AND NOT EXISTS(SELECT 1 FROM blocks bl
                      WHERE (bl.blocker_id = $1 AND bl.blocked_id = other.id)
                         OR (bl.blocker_id = other.id AND bl.blocked_id = $1))
     ORDER BY conv.last_message_at DESC
     LIMIT 100`,
    [me]
  )
  return c.json(result.rows)
})

// GET /messages/unread-count — total across conversations, for badges
messages.get('/unread-count', requireAuth, async (c) => {
  const me = c.get('userId')
  const result = await query(
    `SELECT count(*)::int AS unread
     FROM messages m
     JOIN conversations conv ON conv.id = m.conversation_id
     LEFT JOIN conversation_reads r ON r.conversation_id = conv.id AND r.user_id = $1
     WHERE (conv.a_id = $1 OR conv.b_id = $1)
       AND m.sender_id <> $1
       AND m.hidden = FALSE
       AND m.created_at > COALESCE(r.last_read_at, 'epoch')`,
    [me]
  )
  return c.json(result.rows[0] ?? { unread: 0 })
})

// GET /messages/with/:userId?limit=50 — the thread with one user, oldest
// first. Also marks the thread read (viewing IS reading).
messages.get('/with/:userId', requireAuth, async (c) => {
  const me = c.get('userId')
  const other = c.req.param('userId')
  const limit = Math.min(Number(c.req.query('limit')) || 50, 100)
  const [a, b] = sortPair(me, other)

  const conv = await query('SELECT id FROM conversations WHERE a_id = $1 AND b_id = $2', [a, b])
  const conversationId = conv.rows[0]?.id ?? null
  if (!conversationId) return c.json({ conversation_id: null, messages: [] })

  const rows = await query(
    `SELECT m.id, m.sender_id, m.content, m.created_at,
            CASE WHEN m.shared_post_id IS NOT NULL THEN 'post'
                 WHEN m.shared_article_id IS NOT NULL THEN 'article'
            END AS shared_kind,
            COALESCE(m.shared_post_id, m.shared_article_id) AS shared_id,
            CASE
              WHEN sp.id IS NOT NULL THEN jsonb_build_object(
                'kind', 'post',
                'id', sp.id,
                'text', sp.content,
                'media_url', sp.media_url,
                'position', sp.position,
                'author_id', sp.user_id,
                'author_name', spu.username,
                'author_avatar_url', spu.avatar_url,
                'author_is_demo', spu.is_demo
              )
              WHEN sa.id IS NOT NULL THEN jsonb_build_object(
                'kind', 'article',
                'id', sa.id,
                'title', sa.title,
                'source', sa.source,
                'media_url', sa.media,
                'political_lean', sa.political_lean,
                'source_lean', sa.source_lean,
                'published_at', sa.published_at
              )
            END AS shared
     FROM messages m
     LEFT JOIN posts sp ON sp.id = m.shared_post_id AND NOT sp.hidden
       AND NOT EXISTS(
         SELECT 1 FROM blocks bl
         WHERE (bl.blocker_id = $3 AND bl.blocked_id = sp.user_id)
            OR (bl.blocker_id = sp.user_id AND bl.blocked_id = $3)
       )
     LEFT JOIN userdata spu ON spu.id = sp.user_id
     LEFT JOIN articles sa ON sa.id = m.shared_article_id AND sa.status = 'ready'
     WHERE m.conversation_id = $1 AND m.hidden = FALSE
     ORDER BY m.created_at DESC LIMIT $2`,
    [conversationId, limit, me]
  )
  await query(
    `INSERT INTO conversation_reads (conversation_id, user_id, last_read_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = NOW()`,
    [conversationId, me]
  )
  return c.json({ conversation_id: conversationId, messages: rows.rows.reverse() })
})

// POST /messages/with/:userId  { content?, shared_kind?, shared_id? } — find-or-create the
// conversation, append the message.
messages.post(
  '/with/:userId',
  requireAuth,
  rateLimit({ name: 'sendDm', windowMs: 60_000, max: 30 }),
  async (c) => {
    const me = c.get('userId')
    const other = c.req.param('userId')
    if (other === me) return c.json({ error: "You can't message yourself." }, 400)

    const body = await c.req.json().catch(() => null)
    const content = String(body?.content ?? '').trim()
    const requestedKind = body?.shared_kind == null ? null : String(body.shared_kind)
    const requestedId = body?.shared_id == null ? null : String(body.shared_id)
    if ((requestedKind == null) !== (requestedId == null)) {
      return c.json({ error: 'A shared item needs both its kind and id.' }, 400)
    }
    if (requestedKind !== null && requestedKind !== 'post' && requestedKind !== 'article') {
      return c.json({ error: 'Shared item kind must be post or article.' }, 400)
    }
    if (requestedId !== null && !UUID_PATTERN.test(requestedId)) {
      return c.json({ error: 'Shared item id is invalid.' }, 400)
    }
    if (!content && !requestedKind) return c.json({ error: 'Message is empty.' }, 400)
    if (content.length > 2000) return c.json({ error: 'Message is too long (2000 max).' }, 400)
    const access = await query(
      `SELECT u.is_private,
              EXISTS(
                SELECT 1 FROM follows f
                WHERE f.follower_id = u.id AND f.followee_id = $1 AND f.status = 'accepted'
              ) AS follows_sender,
              EXISTS(
                SELECT 1 FROM blocks b
                WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                   OR (b.blocker_id = u.id AND b.blocked_id = $1)
              ) AS blocked
       FROM userdata u WHERE u.id = $2`,
      [me, other]
    )
    const recipient = access.rows[0]
    if (!recipient) return c.json({ error: 'User not found' }, 404)
    if (recipient.blocked) {
      return c.json({ error: 'You can’t message this account.' }, 403)
    }
    if (recipient.is_private && !recipient.follows_sender) {
      return c.json(
        {
          code: 'PRIVATE_DM_RESTRICTED',
          error: 'This private account must follow you before you can message them.',
        },
        403
      )
    }

    const shared = requestedKind && requestedId
      ? await sharedPreview(requestedKind as SharedKind, requestedId, me, other)
      : null
    if (requestedKind && !shared) {
      return c.json({ error: `Shared ${requestedKind} not found.` }, 404)
    }

    if (content) {
      const moderation = await moderateText(me, 'dm', content)
      const moderationError = moderationFailure(moderation)
      if (moderationError) return c.json(moderationError.body, moderationError.status)
    }

    const [a, b] = sortPair(me, other)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const conv = await client.query(
        `INSERT INTO conversations (a_id, b_id) VALUES ($1, $2)
         ON CONFLICT (a_id, b_id) DO UPDATE SET last_message_at = NOW()
         RETURNING id`,
        [a, b]
      )
      const conversationId = conv.rows[0].id
      const inserted = await client.query(
        `INSERT INTO messages (
           conversation_id, sender_id, content, shared_post_id, shared_article_id
         )
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, sender_id, content, created_at`,
        [
          conversationId,
          me,
          content,
          requestedKind === 'post' ? requestedId : null,
          requestedKind === 'article' ? requestedId : null,
        ]
      )
      await client.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [
        conversationId,
      ])
      // Sending implies you've seen the thread
      await client.query(
        `INSERT INTO conversation_reads (conversation_id, user_id, last_read_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = NOW()`,
        [conversationId, me]
      )
      await client.query('COMMIT')

      const sender = await query('SELECT username FROM userdata WHERE id = $1', [me])
      notify(other, 'dms', {
        title: sender.rows[0]?.username ?? 'New message',
        body: content
          ? content.length > 120 ? `${content.slice(0, 117)}...` : content
          : requestedKind === 'post' ? 'Shared a post' : 'Shared an article',
        data: { url: dmPath(me) },
      })
      return c.json({
        conversation_id: conversationId,
        message: {
          ...inserted.rows[0],
          shared_kind: requestedKind,
          shared_id: requestedId,
          shared,
        },
      }, 201)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
)

export default messages
