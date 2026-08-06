import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEnv } from '../types'

const mocks = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('../db', () => ({ default: { connect: mocks.connect } }))
vi.mock('../middleware/auth', () => ({
  requireAuth: async (c: any, next: any) => { c.set('userId', 'viewer'); await next() },
}))
vi.mock('../middleware/rateLimit', () => ({ rateLimit: () => async (_c: any, next: any) => next() }))

import reposts from './reposts'

const app = new Hono<AppEnv>().route('/reposts', reposts)
const postId = '47dd61db-9ff7-4655-8e1a-332ed366d680'

describe('reposts', () => {
  beforeEach(() => mocks.connect.mockReset())

  it('requires exactly one typed target', async () => {
    const response = await app.request('/reposts/toggle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('creates a repost and returns the combined repost plus quote count', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // begin
        .mockResolvedValueOnce({ rows: [] }) // advisory lock
        .mockResolvedValueOnce({ rows: [] }) // delete misses
        .mockResolvedValueOnce({ rows: [{ id: postId }] }) // target validation
        .mockResolvedValueOnce({ rows: [] }) // insert
        .mockResolvedValueOnce({ rows: [{ repost_count: 4 }] })
        .mockResolvedValueOnce({ rows: [] }), // commit
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)

    const response = await app.request('/reposts/toggle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ post_id: postId }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ reposted: true, repost_count: 4 })
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO reposts'),
      ['viewer', postId],
    )
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('removes an existing repost without validating the target again', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ user_id: 'viewer' }] })
        .mockResolvedValueOnce({ rows: [{ repost_count: 2 }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)

    const response = await app.request('/reposts/toggle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ post_id: postId }),
    })
    await expect(response.json()).resolves.toEqual({ reposted: false, repost_count: 2 })
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO reposts'))).toBe(false)
  })
})
