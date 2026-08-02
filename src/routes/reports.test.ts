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
vi.mock('../middleware/rateLimit', () => ({
  rateLimit: () => async (_c: any, next: any) => next(),
}))

import reports from './reports'

const app = new Hono<AppEnv>().route('/reports', reports)

const reportMessage = () =>
  app.request('/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target_kind: 'message',
      target_id: 'message-id',
      reason: 'harassment',
    }),
  })

describe('private-message reports', () => {
  beforeEach(() => mocks.query.mockReset())

  it('lets a message recipient submit the message to the existing review queue', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await reportMessage()

    expect(response.status).toBe(201)
    expect(mocks.query.mock.calls[0][0]).toContain('m.sender_id <> $2')
    expect(mocks.query.mock.calls[1][0]).toContain('INSERT INTO reports')
    expect(mocks.query.mock.calls[1][1]).toEqual([
      'viewer',
      'message',
      'message-id',
      'harassment',
      null,
    ])
  })

  it('does not create a report when the message is not received by the caller', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] })

    const response = await reportMessage()

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Message not found.' })
    expect(mocks.query).toHaveBeenCalledTimes(1)
  })

  it('continues to reject unsupported target kinds', async () => {
    const response = await app.request('/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target_kind: 'conversation', target_id: 'id', reason: 'spam' }),
    })

    expect(response.status).toBe(400)
    expect(mocks.query).not.toHaveBeenCalled()
  })
})
