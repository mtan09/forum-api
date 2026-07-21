import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { rateLimit } from './rateLimit'

const build = (max: number) => {
  const app = new Hono()
  app.use('*', rateLimit({ name: `test-${Math.random()}`, windowMs: 60_000, max }))
  app.get('/', (c) => c.json({ ok: true }))
  return app
}

describe('rateLimit', () => {
  it('allows requests under the limit', async () => {
    const app = build(3)
    for (let i = 0; i < 3; i++) {
      const res = await app.request('/', { headers: { 'x-forwarded-for': '1.2.3.4' } })
      expect(res.status).toBe(200)
    }
  })

  it('returns 429 with Retry-After once the limit is hit', async () => {
    const app = build(2)
    await app.request('/', { headers: { 'x-forwarded-for': '5.6.7.8' } })
    await app.request('/', { headers: { 'x-forwarded-for': '5.6.7.8' } })
    const res = await app.request('/', { headers: { 'x-forwarded-for': '5.6.7.8' } })
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
  })

  it('tracks clients independently', async () => {
    const app = build(1)
    await app.request('/', { headers: { 'x-forwarded-for': '9.9.9.9' } })
    const other = await app.request('/', { headers: { 'x-forwarded-for': '8.8.8.8' } })
    expect(other.status).toBe(200)
  })
})
