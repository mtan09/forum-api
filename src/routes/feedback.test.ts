import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEnv } from '../types'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../db', () => ({ query: mocks.query }))
vi.mock('../middleware/auth', () => ({
  requireAuth: async (c: any, next: any) => {
    c.set('userId', 'viewer')
    await next()
  },
}))

import feedback from './feedback'

const app = new Hono<AppEnv>().route('/feedback', feedback)

describe('feedback authorization', () => {
  beforeEach(() => mocks.query.mockReset())

  it('rejects a screenshot key owned by another user', async () => {
    const response = await app.request('/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        category: 'bug',
        message: 'The screen crashed.',
        screenshot_key: 'feedback/someone-else/image.jpg',
      }),
    })
    expect(response.status).toBe(400)
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('stores structured metadata without requiring a screenshot', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ id: 'feedback-1', status: 'open', created_at: new Date() }],
    })
    const response = await app.request('/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        category: 'ui',
        message: 'The spacing is inconsistent.',
        route: '/search',
        theme: 'dark',
        app_version: '1.0.0',
        build_number: '2',
      }),
    })
    expect(response.status).toBe(201)
    expect(mocks.query).toHaveBeenCalledOnce()
  })
})
