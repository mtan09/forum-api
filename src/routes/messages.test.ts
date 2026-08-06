import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEnv } from '../types'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  notify: vi.fn(),
  moderateText: vi.fn(async () => ({
    decision: 'allow',
    provider: 'openai',
    categories: [],
  })),
}))

vi.mock('../db', () => ({
  default: { connect: mocks.connect },
  query: mocks.query,
}))
vi.mock('../middleware/auth', () => ({
  requireAuth: async (c: any, next: any) => {
    c.set('userId', 'viewer')
    await next()
  },
}))
vi.mock('../middleware/rateLimit', () => ({
  rateLimit: () => async (_c: any, next: any) => { await next() },
}))
vi.mock('../lib/push', () => ({ notify: mocks.notify }))
vi.mock('../lib/moderation', () => ({
  moderateText: mocks.moderateText,
  moderationFailure: () => null,
}))

import messages from './messages'

const app = new Hono<AppEnv>().route('/messages', messages)

describe('private-account messaging', () => {
  beforeEach(() => {
    mocks.query.mockReset()
    mocks.connect.mockReset()
    mocks.notify.mockReset()
    mocks.moderateText.mockClear()
  })

  it('rejects a DM when the private recipient does not follow the sender', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ is_private: true, follows_sender: false, blocked: false }],
    })

    const response = await app.request('/messages/with/private-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Hello' }),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: 'PRIVATE_DM_RESTRICTED' })
    expect(mocks.moderateText).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('allows a DM when the private recipient follows the sender', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ is_private: true, follows_sender: true, blocked: false }],
      })
      .mockResolvedValueOnce({ rows: [{ username: 'Viewer' }] })

    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'conversation-1' }] })
        .mockResolvedValueOnce({
          rows: [{ id: 'message-1', sender_id: 'viewer', content: 'Hello' }],
        })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)

    const response = await app.request('/messages/with/private-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Hello' }),
    })

    expect(response.status).toBe(201)
    expect(mocks.moderateText).toHaveBeenCalledWith('viewer', 'dm', 'Hello')
    expect(client.query).toHaveBeenCalledWith('COMMIT')
    expect(mocks.notify).toHaveBeenCalledWith(
      'private-user',
      'dms',
      expect.objectContaining({ title: 'Viewer' })
    )
  })

  it('stores an existing article as a typed share without remoderating its headline', async () => {
    const articleId = '11111111-1111-4111-8111-111111111111'
    const shared = {
      kind: 'article',
      id: articleId,
      title: 'A shared headline',
      source: 'Example News',
    }
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ is_private: false, follows_sender: false, blocked: false }],
      })
      .mockResolvedValueOnce({ rows: [{ shared }] })
      .mockResolvedValueOnce({ rows: [{ username: 'Viewer' }] })

    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'conversation-1' }] })
        .mockResolvedValueOnce({
          rows: [{ id: 'message-1', sender_id: 'viewer', content: '' }],
        })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)

    const response = await app.request('/messages/with/public-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shared_kind: 'article', shared_id: articleId }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({ message: { shared } })
    expect(mocks.moderateText).not.toHaveBeenCalled()
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('shared_post_id, shared_article_id'),
      ['conversation-1', 'viewer', '', null, articleId]
    )
    expect(mocks.notify).toHaveBeenCalledWith(
      'public-user',
      'dms',
      expect.objectContaining({ body: 'Shared an article' })
    )
  })
})
