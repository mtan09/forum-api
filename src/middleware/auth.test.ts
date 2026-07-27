import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEnv } from '../types'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  verify: vi.fn(async () => ({ sub: 'user-1' })),
}))

vi.mock('../db', () => ({ query: mocks.query }))
vi.mock('hono/jwt', () => ({ verify: mocks.verify }))
vi.mock('../lib/auth', () => ({ jwtSecret: () => 'test-secret' }))

import { requireAuth } from './auth'

const app = new Hono<AppEnv>()
app.get('/private', requireAuth, (c) => c.json({ user_id: c.get('userId') }))

describe('auth account-state enforcement', () => {
  beforeEach(() => mocks.query.mockReset())

  it('rejects a token whose user has been deleted', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] })
    const response = await app.request('/private', {
      headers: { authorization: 'Bearer token' },
    })
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: 'This account no longer exists.',
    })
  })

  it('rejects a token whose user is banned', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ is_banned: true }] })
    const response = await app.request('/private', {
      headers: { authorization: 'Bearer token' },
    })
    expect(response.status).toBe(403)
  })
})
