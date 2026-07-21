import { Hono } from 'hono'
import pool, { query } from '../db'
import { notify } from '../lib/push'
import { requireAuth } from '../middleware/auth'
import { rateLimit } from '../middleware/rateLimit'
import type { AppEnv } from '../types'

const messages = new Hono<AppEnv>()

// Conversations are keyed by the sorted user pair, so "the conversation
// with user X" is always unique regardless of who messaged first. Client
// screens address threads by the OTHER user's id, never by conversation id.
const sortPair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x])

// Blocks kill DMs in both directions
async function blockedEitherWay(me: string, other: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM blocks
     WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
     LIMIT 1`,
    [me, other]
  )
  return !!result.rows[0]
}

// GET /messages — the inbox: every conversation, newest activity first,
// with the other participant, last message preview, and unread count.
messages.get('/', requireAuth, async (c) => {
  const me = c.get('userId')
  const result = await query(
    `SELECT conv.id AS conversation_id,
            other.id AS user_id, other.username, other.avatar_url,
            conv.last_message_at,
            lm.content AS last_message,
            lm.sender_id AS last_sender_id,
            (SELECT count(*)::int FROM messages m
             WHERE m.conversation_id = conv.id
               AND m.sender_id <> $1
               AND m.created_at > COALESCE(r.last_read_at, 'epoch')) AS unread
     FROM conversations conv
     JOIN userdata other ON other.id = CASE WHEN conv.a_id = $1 THEN conv.b_id ELSE conv.a_id END
     LEFT JOIN conversation_reads r ON r.conversation_id = conv.id AND r.user_id = $1
     LEFT JOIN LATERAL (
       SELECT content, sender_id FROM messages m
       WHERE m.conversation_id = conv.id ORDER BY m.created_at DESC LIMIT 1
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
    `SELECT id, sender_id, content, created_at
     FROM messages WHERE conversation_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [conversationId, limit]
  )
  await query(
    `INSERT INTO conversation_reads (conversation_id, user_id, last_read_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = NOW()`,
    [conversationId, me]
  )
  return c.json({ conversation_id: conversationId, messages: rows.rows.reverse() })
})

// POST /messages/with/:userId  { content } — find-or-create the
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
    if (!content) return c.json({ error: 'Message is empty.' }, 400)
    if (content.length > 2000) return c.json({ error: 'Message is too long (2000 max).' }, 400)

    const exists = await query('SELECT 1 FROM userdata WHERE id = $1', [other])
    if (!exists.rows[0]) return c.json({ error: 'User not found' }, 404)
    if (await blockedEitherWay(me, other)) {
      return c.json({ error: 'You can’t message this account.' }, 403)
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
        `INSERT INTO messages (conversation_id, sender_id, content)
         VALUES ($1, $2, $3) RETURNING id, sender_id, content, created_at`,
        [conversationId, me, content]
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
        body: content.length > 120 ? `${content.slice(0, 117)}...` : content,
        data: { url: `/dm/${me}` },
      })
      return c.json({ conversation_id: conversationId, message: inserted.rows[0] }, 201)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
)

export default messages
