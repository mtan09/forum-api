import { createMiddleware } from 'hono/factory'
import { verify } from 'hono/jwt'
import { jwtSecret } from '../lib/auth'
import type { AppEnv } from '../types'

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
    c.set('userId', payload.sub)
    await next()
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
})
