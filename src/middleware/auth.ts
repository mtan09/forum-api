import { createMiddleware } from 'hono/factory'
import { verify } from 'hono/jwt'
import { jwtSecret } from '../lib/auth'
import type { AppEnv } from '../types'

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
