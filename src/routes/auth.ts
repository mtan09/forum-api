import { randomBytes, randomInt, randomUUID } from 'crypto'
import { Hono } from 'hono'
import pool from '../db'
import { AI_CONSENT_VERSION } from '../lib/ai-consent'
import { hashPassword, issueToken, verifyPassword } from '../lib/auth'
import { resetEmail, sendEmail, verificationEmail } from '../lib/email'
import { moderateText, moderationFailure } from '../lib/moderation'
import { publicApiOrigin } from '../lib/public-url'
import { requireAuth } from '../middleware/auth'
import { rateLimit } from '../middleware/rateLimit'
import type { AppEnv } from '../types'

const auth = new Hono<AppEnv>()

const PUBLIC_USER_COLS = 'id, username, avatar_url, bio, header_url, is_demo, created_at'

// Unauthenticated, so both throttles key by IP: signup blocks bot floods,
// login blocks credential stuffing.
const signupLimit = rateLimit({ name: 'signup', windowMs: 60 * 60_000, max: 10,
  message: 'Too many accounts created from this device — try again later.' })
const loginLimit = rateLimit({ name: 'login', windowMs: 15 * 60_000, max: 10,
  message: 'Too many login attempts — wait a few minutes and try again.' })

// One live token per (user, kind): issuing a new one invalidates the old.
async function issueEmailToken(userId: string, kind: 'verify' | 'reset'): Promise<string> {
  const token = kind === 'verify'
    ? randomBytes(24).toString('hex')
    : String(randomInt(100000, 1000000)) // 6-digit code typed into the app
  const ttlMs = kind === 'verify' ? 7 * 24 * 60 * 60_000 : 60 * 60_000
  await pool.query('DELETE FROM email_tokens WHERE user_id = $1 AND kind = $2', [userId, kind])
  await pool.query(
    'INSERT INTO email_tokens (token, user_id, kind, expires_at) VALUES ($1, $2, $3, $4)',
    [token, userId, kind, new Date(Date.now() + ttlMs)]
  )
  return token
}

async function sendVerification(userId: string, email: string, origin: string): Promise<void> {
  const token = await issueEmailToken(userId, 'verify')
  const { subject, html } = verificationEmail(`${origin}/auth/verify?token=${token}`)
  await sendEmail({ to: email, subject, html })
}

// POST /auth/signup
// { username, email, password, ai_consent_accepted, ai_consent_version }
auth.post('/signup', signupLimit, async (c) => {
  const body = await c.req.json().catch(() => null)
  const username = String(body?.username ?? '').trim()
  const email = String(body?.email ?? '').trim().toLowerCase()
  const password = String(body?.password ?? '')
  const consentAccepted =
    typeof body?.ai_consent_accepted === 'boolean' ? body.ai_consent_accepted : null
  const consentVersion = String(body?.ai_consent_version ?? '')

  if (username.length < 3 || username.length > 24) {
    return c.json({ error: 'Username must be 3–24 characters.' }, 400)
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Enter a valid email address.' }, 400)
  }
  if (password.length < 6) {
    return c.json({ error: 'Password must be at least 6 characters.' }, 400)
  }
  if (consentAccepted === null) {
    return c.json(
      {
        code: 'AI_CONSENT_DECISION_REQUIRED',
        error: 'Choose whether to allow OpenAI processing before creating your account.',
      },
      400
    )
  }
  if (consentVersion !== AI_CONSENT_VERSION) {
    return c.json(
      {
        code: 'AI_CONSENT_VERSION_MISMATCH',
        error: 'The AI data-sharing disclosure has changed. Please review it again.',
        consent_version: AI_CONSENT_VERSION,
      },
      409
    )
  }
  const moderation = await moderateText(null, 'username', username, {
    // A declined signup remains available. Its username is checked only by
    // forum's deterministic rules and is never shared with OpenAI.
    useProvider: consentAccepted,
  })
  const moderationError = moderationFailure(moderation)
  if (moderationError) return c.json(moderationError.body, moderationError.status)

  const userId = randomUUID()
  const passwordHash = await hashPassword(password)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const userResult = await client.query(
      `INSERT INTO userdata (id, username) VALUES ($1, $2) RETURNING ${PUBLIC_USER_COLS}`,
      [userId, username]
    )
    await client.query(
      'INSERT INTO auth_credentials (user_id, email, password_hash) VALUES ($1, $2, $3)',
      [userId, email, passwordHash]
    )
    await client.query(
      `INSERT INTO ai_data_consents (user_id, consent_version, status, decided_at)
       VALUES ($1, $2, $3, NOW())`,
      [userId, AI_CONSENT_VERSION, consentAccepted ? 'accepted' : 'declined']
    )
    await client.query('COMMIT')

    const token = await issueToken(userId)
    // Fire-and-forget so a slow mail provider never delays signup
    sendVerification(userId, email, publicApiOrigin(c.req.raw))
      .catch((err) => console.error('[email] verification send failed:', err?.message))
    return c.json(
      {
        token,
        user: {
          ...userResult.rows[0],
          email,
          email_verified: false,
          ai_consent_status: consentAccepted ? 'accepted' : 'declined',
          ai_consent_current: consentAccepted,
          ai_consent_version: AI_CONSENT_VERSION,
        },
      },
      201
    )
  } catch (err: any) {
    await client.query('ROLLBACK')
    if (err?.code === '23505') {
      const taken = String(err.constraint ?? '').includes('email') ? 'Email' : 'Username'
      return c.json({ error: `${taken} is already taken.` }, 409)
    }
    throw err
  } finally {
    client.release()
  }
})

// POST /auth/login  { email, password }
auth.post('/login', loginLimit, async (c) => {
  const body = await c.req.json().catch(() => null)
  const email = String(body?.email ?? '').trim().toLowerCase()
  const password = String(body?.password ?? '')

  if (!email || !password) {
    return c.json({ error: 'Email and password are required.' }, 400)
  }

  const result = await pool.query(
    `SELECT u.id, u.username, u.avatar_url, u.bio, u.header_url, u.is_demo, u.created_at,
            u.is_banned, a.email, a.email_verified, a.password_hash,
            COALESCE(ai.status, 'not_asked') AS ai_consent_status,
            ai.consent_version AS ai_consent_version,
            (ai.status = 'accepted' AND ai.consent_version = $2) AS ai_consent_current
     FROM auth_credentials a
     JOIN userdata u ON u.id = a.user_id
     LEFT JOIN ai_data_consents ai ON ai.user_id = u.id
     WHERE a.email = $1`,
    [email, AI_CONSENT_VERSION]
  )

  const row = result.rows[0]
  const valid = row ? await verifyPassword(password, row.password_hash) : false
  if (!valid) {
    return c.json({ error: 'Invalid email or password.' }, 401)
  }
  if (row.is_banned) {
    return c.json({ error: 'This account has been suspended.' }, 403)
  }

  const { password_hash: _hash, is_banned: _banned, ...user } = row
  const token = await issueToken(user.id)
  return c.json({ token, user })
})

// POST /auth/change-password  { current_password, new_password }
auth.post('/change-password', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null)
  const currentPassword = String(body?.current_password ?? '')
  const newPassword = String(body?.new_password ?? '')

  if (newPassword.length < 6) {
    return c.json({ error: 'New password must be at least 6 characters.' }, 400)
  }

  const result = await pool.query(
    'SELECT password_hash FROM auth_credentials WHERE user_id = $1',
    [c.get('userId')]
  )
  const row = result.rows[0]
  const valid = row ? await verifyPassword(currentPassword, row.password_hash) : false
  if (!valid) {
    return c.json({ error: 'Current password is incorrect.' }, 401)
  }

  const newHash = await hashPassword(newPassword)
  await pool.query('UPDATE auth_credentials SET password_hash = $1 WHERE user_id = $2', [
    newHash,
    c.get('userId'),
  ])
  return c.json({ ok: true })
})

// GET /auth/verify?token= — the link from the verification email; opens in
// a browser, so respond with a tiny human-readable page.
auth.get('/verify', async (c) => {
  const token = c.req.query('token') ?? ''
  const page = (title: string, body: string, ok: boolean) =>
    c.html(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:420px;margin:15vh auto;padding:24px;text-align:center">
        <h1 style="color:${ok ? '#B647FF' : '#DC2626'}">${title}</h1><p style="color:#5A5A5A">${body}</p>
      </div>`)

  const result = await pool.query(
    `WITH claimed AS (
       DELETE FROM email_tokens
       WHERE token = $1 AND kind = 'verify' AND expires_at > NOW()
       RETURNING user_id
     )
     UPDATE auth_credentials AS credentials
     SET email_verified = TRUE
     FROM claimed
     WHERE credentials.user_id = claimed.user_id
     RETURNING credentials.user_id`,
    [token]
  )
  const row = result.rows[0]
  if (!row) return page('Link expired', 'Request a new verification email from Settings in the app.', false)
  return page('Email verified ✓', 'You can close this page and head back to the app.', true)
})

// POST /auth/resend-verification — authed; re-sends the link
auth.post(
  '/resend-verification',
  requireAuth,
  rateLimit({ name: 'resendVerify', windowMs: 60 * 60_000, max: 3,
    message: 'Verification email already sent — check your inbox (and spam).' }),
  async (c) => {
    const result = await pool.query(
      'SELECT email, email_verified FROM auth_credentials WHERE user_id = $1',
      [c.get('userId')]
    )
    const row = result.rows[0]
    if (!row) return c.json({ error: 'User not found' }, 404)
    if (row.email_verified) return c.json({ ok: true, already_verified: true })
    await sendVerification(c.get('userId'), row.email, publicApiOrigin(c.req.raw))
    return c.json({ ok: true })
  }
)

// POST /auth/forgot-password  { email } — always 200 so the response never
// reveals whether an account exists.
auth.post(
  '/forgot-password',
  rateLimit({ name: 'forgot', windowMs: 60 * 60_000, max: 5,
    message: 'Too many reset requests — try again later.' }),
  async (c) => {
    const body = await c.req.json().catch(() => null)
    const email = String(body?.email ?? '').trim().toLowerCase()
    if (!email) return c.json({ error: 'Email is required.' }, 400)

    const result = await pool.query('SELECT user_id FROM auth_credentials WHERE email = $1', [email])
    const row = result.rows[0]
    if (row) {
      const code = await issueEmailToken(row.user_id, 'reset')
      const { subject, html } = resetEmail(code)
      sendEmail({ to: email, subject, html })
        .catch((err) => console.error('[email] reset send failed:', err?.message))
    }
    return c.json({ ok: true })
  }
)

// POST /auth/reset-password  { email, code, new_password }
auth.post(
  '/reset-password',
  rateLimit({ name: 'reset', windowMs: 60 * 60_000, max: 10 }),
  async (c) => {
    const body = await c.req.json().catch(() => null)
    const email = String(body?.email ?? '').trim().toLowerCase()
    const code = String(body?.code ?? '').trim()
    const newPassword = String(body?.new_password ?? '')
    if (!email || !code) return c.json({ error: 'Email and code are required.' }, 400)
    if (newPassword.length < 6) {
      return c.json({ error: 'Password must be at least 6 characters.' }, 400)
    }

    const cred = await pool.query('SELECT user_id FROM auth_credentials WHERE email = $1', [email])
    const userId = cred.rows[0]?.user_id
    if (!userId) return c.json({ error: 'Invalid or expired code.' }, 400)

    // Count the attempt first so codes can't be brute-forced
    const tok = await pool.query(
      `UPDATE email_tokens SET attempts = attempts + 1
       WHERE user_id = $1 AND kind = 'reset' AND expires_at > NOW() AND attempts < 5
       RETURNING token`,
      [userId]
    )
    if (!tok.rows[0] || tok.rows[0].token !== code) {
      return c.json({ error: 'Invalid or expired code.' }, 400)
    }

    const newHash = await hashPassword(newPassword)
    await pool.query('UPDATE auth_credentials SET password_hash = $1, email_verified = TRUE WHERE user_id = $2',
      [newHash, userId])
    await pool.query("DELETE FROM email_tokens WHERE user_id = $1 AND kind = 'reset'", [userId])
    return c.json({ ok: true })
  }
)

export default auth
