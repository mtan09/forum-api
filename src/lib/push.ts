import { query } from '../db'

// Server-side push via Expo's push service. Tokens come from the app
// (POST /users/me/push-token); prefs gate every send so the Settings
// toggles actually control delivery. All sends are fire-and-forget —
// notification failures must never fail the triggering request.

type PushKind = 'replies' | 'upvotes' | 'dms'

type PushPayload = {
  title: string
  body: string
  /** Deep-link data the app uses to route the tap (e.g. { url: '/post/123' }) */
  data?: Record<string, unknown>
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const CHUNK = 100

export function notify(userId: string, kind: PushKind, payload: PushPayload): void {
  deliver(userId, kind, payload).catch((err) =>
    console.error('[push] send failed:', err?.message ?? err)
  )
}

async function deliver(userId: string, kind: PushKind, payload: PushPayload): Promise<void> {
  const prefs = await query(
    `SELECT COALESCE(p.push_enabled, TRUE) AS push_enabled, COALESCE(p.${kind}, TRUE) AS kind_enabled
     FROM userdata u LEFT JOIN notification_prefs p ON p.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  )
  const row = prefs.rows[0]
  if (!row || !row.push_enabled || !row.kind_enabled) return

  const tokens = await query('SELECT token FROM push_tokens WHERE user_id = $1', [userId])
  if (tokens.rows.length === 0) return

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
      }
    })
  }
}
