import { createMiddleware } from 'hono/factory'
import { verify } from 'hono/jwt'
import { query } from '../db'
import { jwtSecret } from '../lib/auth'
import type { AppEnv } from '../types'

// JWTs are intentionally stateless, but every authenticated request still
// resolves the account. That makes deletion and suspension effective
// immediately even when a previously issued token has weeks left.
async function accountState(userId: string): Promise<'active' | 'banned' | 'missing'> {
  const result = await query('SELECT is_banned FROM userdata WHERE id = $1', [userId])
  if (!result.rows[0]) return 'missing'
  return result.rows[0].is_banned ? 'banned' : 'active'
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
      if (typeof payload.sub === 'string' && (await accountState(payload.sub)) === 'active') {
        c.set('userId', payload.sub)
      }
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
    const state = await accountState(payload.sub)
    if (state === 'missing') {
      return c.json({ error: 'This account no longer exists.' }, 401)
    }
    if (state === 'banned') {
      return c.json({ error: 'This account has been suspended.' }, 403)
    }
    c.set('userId', payload.sub)
    await next()
  } catch (err) {
    if (err instanceof Response) throw err
    return c.json({ error: 'Invalid token' }, 401)
  }
})
