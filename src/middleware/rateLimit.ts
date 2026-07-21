import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context, Next } from 'hono'

// Sliding-window rate limiter, in-process. Counters live in memory: correct
// for the current single-instance deployment, and the call sites don't change
// if this ever moves to Redis/Postgres for multi-instance.
//
// Keying: authenticated routes key by user id (set by requireAuth upstream),
// everything else by client IP (X-Forwarded-For aware, so it works behind
// Railway/Fly/Render proxies).

type Options = {
  /** Bucket name — isolates each limiter's counters. */
  name: string
  windowMs: number
  max: number
  /** Override the error message (e.g. to explain a daily cap). */
  message?: string
}

const buckets = new Map<string, number[]>()

// Sweep stale entries so long-lived processes don't leak.
const sweeper = setInterval(() => {
  const cutoff = Date.now() - 60 * 60_000
  for (const [key, hits] of buckets) {
    const keep = hits.filter((t) => t > cutoff)
    if (keep.length === 0) buckets.delete(key)
    else buckets.set(key, keep)
  }
}, 10 * 60_000)
sweeper.unref()

export function clientKey(c: Context): string {
  const userId = c.get('userId') as string | undefined
  if (userId) return `u:${userId}`
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) return `ip:${forwarded.split(',')[0].trim()}`
  try {
    return `ip:${getConnInfo(c).remote.address ?? 'unknown'}`
  } catch {
    return 'ip:unknown'
  }
}

export function rateLimit({ name, windowMs, max, message }: Options) {
  return async (c: Context, next: Next) => {
    const key = `${name}:${clientKey(c)}`
    const now = Date.now()
    const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs)
    if (hits.length >= max) {
      c.header('Retry-After', String(Math.ceil((windowMs - (now - hits[0])) / 1000)))
      return c.json(
        { error: message ?? 'Too many requests — please slow down and try again shortly.' },
        429
      )
    }
    hits.push(now)
    buckets.set(key, hits)
    await next()
  }
}
