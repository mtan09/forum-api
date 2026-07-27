import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEnv } from '../types'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  notify: vi.fn(),
  moderateText: vi.fn(async () => ({
    decision: 'allow',
    provider: 'openai',
    categories: [],
  })),
}))

vi.mock('../db', () => ({
  default: { connect: vi.fn() },
  query: mocks.query,
}))
vi.mock('../middleware/auth', () => ({
  requireAuth: async (c: any, next: any) => {
    c.set('userId', 'viewer')
    await next()
  },
}))
vi.mock('../lib/push', () => ({ notify: mocks.notify }))
vi.mock('../lib/moderation', () => ({
  moderateText: mocks.moderateText,
  moderationFailure: () => null,
}))

import users from './users'

const app = new Hono<AppEnv>().route('/users', users)

describe('private follows and notification preferences', () => {
  beforeEach(() => {
    mocks.query.mockReset()
    mocks.notify.mockReset()
  })

  it('creates a pending request for a private account', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ is_private: true, username: 'Private', blocked: false }] })
      .mockResolvedValueOnce({ rows: [{ status: 'pending' }] })
      .mockResolvedValueOnce({ rows: [{ username: 'Viewer' }] })
    const response = await app.request('/users/target/follow', { method: 'POST' })
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({ follow_status: 'pending' })
    expect(mocks.notify).toHaveBeenCalledWith(
      'target',
      'follows',
      expect.objectContaining({ title: 'New follow request' })
    )
  })

  it('accepts only an existing pending request', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ follower_id: 'requester' }] })
      .mockResolvedValueOnce({ rows: [{ username: 'Owner' }] })
    const response = await app.request('/users/follow-requests/requester/accept', {
      method: 'POST',
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ follow_status: 'accepted' })
  })

  it('requires verified email before global email delivery is enabled', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ email_verified: false }] })
    const response = await app.request('/users/me/notification-prefs', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email_enabled: true }),
    })
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' })
  })

  it('accepts the legacy push preference shape during migration', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] })
    const response = await app.request('/users/me/notification-prefs', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replies: false, upvotes: true }),
    })
    expect(response.status).toBe(200)
    expect(mocks.query.mock.calls[0][1][3]).toBe(false)
    expect(mocks.query.mock.calls[0][1][4]).toBe(true)
  })
})
