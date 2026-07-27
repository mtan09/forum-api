import { query } from '../db'
import { notificationEmail, sendEmail } from './email'
import { captureException, captureMessage } from './sentry'

// Server-side push via Expo's push service. Tokens come from the app
// (POST /users/me/push-token); prefs gate every send so the Settings
// toggles actually control delivery. All sends are fire-and-forget —
// notification failures must never fail the triggering request.

export type NotificationKind = 'replies' | 'upvotes' | 'dms' | 'follows'

type PushPayload = {
  title: string
  body: string
  /** Deep-link data the app uses to route the tap (e.g. { url: '/post/123' }) */
  data?: Record<string, unknown>
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const CHUNK = 100

export function notify(userId: string, kind: NotificationKind, payload: PushPayload): void {
  deliver(userId, kind, payload).catch((err) => {
    console.error('[push] send failed:', err?.message ?? err)
    captureException(err, { component: 'notification-delivery', kind })
  })
}

function notificationLink(payload: PushPayload): string | undefined {
  const base = process.env.WEB_APP_URL?.replace(/\/$/, '')
  const path = typeof payload.data?.url === 'string' ? payload.data.url : null
  return base && path ? `${base}${path.startsWith('/') ? path : `/${path}`}` : undefined
}

async function deliver(
  userId: string,
  kind: NotificationKind,
  payload: PushPayload
): Promise<void> {
  const prefs = await query(
    `SELECT COALESCE(p.push_enabled, TRUE) AS push_enabled,
            COALESCE(p.push_${kind}, TRUE) AS push_kind_enabled,
            COALESCE(p.email_enabled, FALSE) AS email_enabled,
            COALESCE(p.email_${kind}, ${kind === 'replies' || kind === 'dms' ? 'TRUE' : 'FALSE'})
              AS email_kind_enabled,
            a.email, COALESCE(a.email_verified, FALSE) AS email_verified
     FROM userdata u
     LEFT JOIN notification_prefs p ON p.user_id = u.id
     LEFT JOIN auth_credentials a ON a.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  )
  const row = prefs.rows[0]
  if (!row) return

  if (row.push_enabled && row.push_kind_enabled) {
    const tokens = await query('SELECT token FROM push_tokens WHERE user_id = $1', [userId])
    const messages = tokens.rows.map((t) => ({
      to: t.token,
      sound: 'default' as const,
      title: payload.title,
      body: payload.body,
      data: payload.data ?? {},
    }))

    for (let i = 0; i < messages.length; i += CHUNK) {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(messages.slice(i, i + CHUNK)),
      })
      if (!res.ok) {
        console.error('[push] expo push error:', res.status, (await res.text()).slice(0, 200))
        captureMessage('Expo push request failed', 'warning', {
          status: res.status,
          batch_size: messages.slice(i, i + CHUNK).length,
        })
        continue
      }
      // Prune tokens Expo reports as dead so we stop pushing to them
      const result = (await res.json().catch(() => null)) as {
        data?: { status: string; details?: { error?: string } }[]
      } | null
      const batch = messages.slice(i, i + CHUNK)
      result?.data?.forEach((ticket, idx) => {
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          query('DELETE FROM push_tokens WHERE token = $1', [batch[idx].to]).catch(() => {})
        } else if (ticket.status === 'error') {
          captureMessage('Expo push ticket failed', 'warning', {
            error: ticket.details?.error ?? 'unknown',
          })
        }
      })
    }
  }

  if (!row.email_enabled || !row.email_kind_enabled || !row.email_verified || !row.email) return

  if (kind === 'upvotes' && typeof payload.data?.post_id === 'string') {
    await query(
      `INSERT INTO notification_email_digests (user_id, post_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, post_id) DO UPDATE SET
         upvote_count = notification_email_digests.upvote_count + 1,
         updated_at = NOW()`,
      [userId, payload.data.post_id]
    )
    return
  }

  const message = notificationEmail(payload.title, payload.body, notificationLink(payload))
  await sendEmail({ to: row.email, ...message })
}

export async function flushEmailDigests(limit = 50): Promise<number> {
  const due = await query(
    `SELECT d.user_id, d.post_id, d.upvote_count, a.email
     FROM notification_email_digests d
     JOIN auth_credentials a ON a.user_id = d.user_id AND a.email_verified
     JOIN notification_prefs p ON p.user_id = d.user_id
     WHERE d.scheduled_for <= NOW()
       AND p.email_enabled AND p.email_upvotes
     ORDER BY d.scheduled_for
     LIMIT $1`,
    [limit]
  )
  let sent = 0
  for (const row of due.rows) {
    const subject = `${row.upvote_count} new upvote${row.upvote_count === 1 ? '' : 's'} on your post`
    const message = notificationEmail(
      subject,
      `Your post received ${row.upvote_count} new upvote${row.upvote_count === 1 ? '' : 's'}.`,
      process.env.WEB_APP_URL
        ? `${process.env.WEB_APP_URL.replace(/\/$/, '')}/post/${row.post_id}`
        : undefined
    )
    try {
      await sendEmail({ to: row.email, ...message })
      await query(
        'DELETE FROM notification_email_digests WHERE user_id = $1 AND post_id = $2',
        [row.user_id, row.post_id]
      )
      sent++
    } catch (err: any) {
      console.error('[email] digest send failed:', err?.message ?? err)
      captureException(err, { component: 'upvote-email-digest' })
    }
  }
  // Preferences may have been disabled after a digest was queued.
  await query(
    `DELETE FROM notification_email_digests d
     USING notification_prefs p
     WHERE p.user_id = d.user_id AND (NOT p.email_enabled OR NOT p.email_upvotes)`
  )
  return sent
}
