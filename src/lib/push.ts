import { query } from '../db'
import { notificationEmail, sendEmail } from './email'
import { postPath } from './notification-routes'
import { captureException, captureMessage } from './sentry'

// Server-side push via Expo's push service. Tokens come from the app
// (POST /users/me/push-token); prefs gate every send so the Settings
// toggles actually control delivery. All sends are fire-and-forget —
// notification failures must never fail the triggering request.

export type NotificationKind = 'replies' | 'upvotes' | 'dms' | 'follows' | 'daily_brief'

type PushPayload = {
  title: string
  body: string
  /** Deep-link data the app uses to route the tap (e.g. { url: '/post/123' }) */
  data?: Record<string, unknown>
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts'
const CHUNK = 100
const RECEIPT_CHUNK = 1000

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

export async function deliver(
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
    await sendPushToUser(userId, kind, payload)
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

/**
 * Send a server-authorized push after the caller has applied preference gates.
 *
 * Returns how many messages Expo accepted. This function never throws — no
 * tokens, a non-2xx from Expo, and a rejected ticket are all logged and
 * swallowed — so a caller that needs to know whether anything actually went
 * out MUST check the return value. Treating a call as delivered because it
 * did not throw marks a notification sent that nobody received.
 */
export async function sendPushToUser(
  userId: string,
  kind: NotificationKind,
  payload: PushPayload
): Promise<number> {
    let accepted = 0
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
        data?: { status: string; id?: string; details?: { error?: string } }[]
      } | null
      const batch = messages.slice(i, i + CHUNK)
      const ticketWrites = result?.data?.map(async (ticket, idx) => {
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          await query('DELETE FROM push_tokens WHERE token = $1', [batch[idx].to])
        } else if (ticket.status === 'error') {
          captureMessage('Expo push ticket failed', 'warning', {
            error: ticket.details?.error ?? 'unknown',
          })
        } else if (ticket.status === 'ok' && ticket.id && batch[idx]?.to) {
          // A successful ticket only means Expo accepted the message. Store
          // its opaque id and check the final APNs/FCM receipt later.
          accepted++
          await query(
            `INSERT INTO push_receipts (ticket_id, token, user_id, kind)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (ticket_id) DO NOTHING`,
            [ticket.id, batch[idx].to, userId, kind]
          )
        } else if (ticket.status === 'ok') {
          accepted++
          captureMessage('Expo push ticket missing receipt id', 'warning', { kind })
        }
      }) ?? []
      await Promise.all(ticketWrites)
    }
    return accepted
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
      notificationLink({ title: subject, body: '', data: { url: postPath(row.post_id) } })
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

type ExpoReceipt = {
  status?: string
  message?: string
  details?: { error?: string }
}

export type PushReceiptRun = {
  checked: number
  delivered: number
  failed: number
  pending: number
  tokensPruned: number
  expired: number
}

// Expo push tickets are only the first half of delivery. Receipts contain the
// downstream APNs/FCM result and are normally available around 15 minutes
// later. Expo removes them after 24 hours, so stale rows are bounded too.
export async function processPushReceipts(limit = 1000): Promise<PushReceiptRun> {
  const expired = await query(
    `DELETE FROM push_receipts
     WHERE created_at < NOW() - INTERVAL '24 hours'
     RETURNING ticket_id`
  )
  if (expired.rowCount) {
    captureMessage('Expo push receipts expired before confirmation', 'warning', {
      count: expired.rowCount,
    })
  }

  const due = await query(
    `SELECT ticket_id, token, kind
     FROM push_receipts
     WHERE next_attempt_at <= NOW()
     ORDER BY next_attempt_at
     LIMIT $1`,
    [limit]
  )
  const stats: PushReceiptRun = {
    checked: 0,
    delivered: 0,
    failed: 0,
    pending: 0,
    tokensPruned: 0,
    expired: expired.rowCount ?? 0,
  }

  for (let i = 0; i < due.rows.length; i += RECEIPT_CHUNK) {
    const batch = due.rows.slice(i, i + RECEIPT_CHUNK)
    const ids = batch.map((row) => row.ticket_id)
    let response: Response
    try {
      response = await fetch(EXPO_RECEIPTS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
    } catch (err: any) {
      await query(
        `UPDATE push_receipts
         SET attempts = attempts + 1,
             last_attempt_at = NOW(),
             next_attempt_at = NOW() + INTERVAL '15 minutes',
             last_error = 'receipt_request_failed'
         WHERE ticket_id = ANY($1::text[])`,
        [ids]
      )
      captureException(err, { component: 'push-receipts', batch_size: ids.length })
      stats.pending += ids.length
      continue
    }

    if (!response.ok) {
      await query(
        `UPDATE push_receipts
         SET attempts = attempts + 1,
             last_attempt_at = NOW(),
             next_attempt_at = NOW() + INTERVAL '15 minutes',
             last_error = $2
         WHERE ticket_id = ANY($1::text[])`,
        [ids, `http_${response.status}`]
      )
      captureMessage('Expo push receipt request failed', 'warning', {
        status: response.status,
        batch_size: ids.length,
      })
      stats.pending += ids.length
      continue
    }

    const payload = (await response.json().catch(() => null)) as {
      data?: Record<string, ExpoReceipt>
    } | null
    const receipts = payload?.data ?? {}

    for (const row of batch) {
      stats.checked++
      const receipt = receipts[row.ticket_id]
      if (!receipt) {
        await query(
          `UPDATE push_receipts
           SET attempts = attempts + 1,
               last_attempt_at = NOW(),
               next_attempt_at = NOW() + INTERVAL '15 minutes',
               last_error = 'receipt_not_ready'
           WHERE ticket_id = $1`,
          [row.ticket_id]
        )
        stats.pending++
        continue
      }

      if (receipt.status === 'ok') {
        await query('DELETE FROM push_receipts WHERE ticket_id = $1', [row.ticket_id])
        stats.delivered++
        continue
      }

      const error = receipt.details?.error ?? 'unknown'
      if (error === 'DeviceNotRegistered') {
        await query('DELETE FROM push_tokens WHERE token = $1', [row.token])
        stats.tokensPruned++
      }
      await query('DELETE FROM push_receipts WHERE ticket_id = $1', [row.ticket_id])
      captureMessage('Expo push receipt failed', 'warning', {
        error,
        kind: row.kind,
      })
      stats.failed++
    }
  }

  return stats
}
