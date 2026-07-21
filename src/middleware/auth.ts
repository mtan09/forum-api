import { createMiddleware } from 'hono/factory'
import { verify } from 'hono/jwt'
import { query } from '../db'
import { jwtSecret } from '../lib/auth'
import type { AppEnv } from '../types'

// Banned users keep a valid JWT until it expires, so bans are enforced
// here. Cached for a minute per user to avoid a DB hit on every request.
const banCache = new Map<string, { at: number; banned: boolean }>()
const BAN_TTL_MS = 60_000

async function isBanned(userId: string): Promise<boolean> {
  const cached = banCache.get(userId)
  if (cached && Date.now() - cached.at < BAN_TTL_MS) return cached.banned
  const result = await query('SELECT is_banned FROM userdata WHERE id = $1', [userId])
  const banned = !!result.rows[0]?.is_banned
  banCache.set(userId, { at: Date.now(), banned })
  return banned
}

// Sets userId when a valid token is present, but never rejects — for
// public endpoints that personalize their response (e.g. my_vote on
// articles) when the caller happens to be logged in.
export const optionalAuth = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization')
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (token) {
    try {
      const payload = await verify(token, jwtSecret(), 'HS256')
      if (typeof payload.sub === 'string') c.set('userId', payload.sub)
    } catch {
      // invalid token on a public route: proceed anonymously
    }
  }
  await next()
})

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization')
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  try {
    const payload = await verify(token, jwtSecret(), 'HS256')
    if (typeof payload.sub !== 'string') throw new Error('missing sub')
    if (await isBanned(payload.sub)) {
      return c.json({ error: 'This account has been suspended.' }, 403)
    }
    c.set('userId', payload.sub)
    await next()
  } catch (err) {
    if (err instanceof Response) throw err
    return c.json({ error: 'Invalid token' }, 401)
  }
})
