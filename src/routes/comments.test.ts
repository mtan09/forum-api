import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEnv } from '../types'

const mocks = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn() }))

vi.mock('../db', () => ({
  default: { connect: mocks.connect },
  query: mocks.query,
}))
vi.mock('../middleware/auth', () => ({
  requireAuth: async (c: any, next: any) => {
    c.set('userId', 'owner')
    await next()
  },
}))
vi.mock('../lib/push', () => ({ notify: vi.fn() }))
vi.mock('../lib/moderation', () => ({
  moderateText: vi.fn(),
  moderationFailure: vi.fn(),
}))

import comments from './comments'

const app = new Hono<AppEnv>().route('/comments', comments)

describe('comment deletion', () => {
  beforeEach(() => {
    mocks.connect.mockReset()
    mocks.query.mockReset()
  })

  it('rejects deletion by someone other than the author', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ user_id: 'another' }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)

    const response = await app.request('/comments/comment-1', { method: 'DELETE' })

    expect(response.status).toBe(403)
    expect(String(client.query.mock.calls.at(-1)?.[0]).trim()).toBe('ROLLBACK')
  })

  it('deletes the reply subtree and reduces the parent post count exactly once', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{
          user_id: 'owner',
          post_id: 'post-1',
          article_id: null,
          debate_id: null,
          parent_comment_id: 'parent-1',
        }] })
        .mockResolvedValueOnce({ rows: [{ ids: ['comment-1', 'reply-1'], count: 2 }] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)

    const response = await app.request('/comments/comment-1', { method: 'DELETE' })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      removed_comment_count: 2,
      post_id: 'post-1',
      parent_comment_id: 'parent-1',
    })
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("target_kind = 'comment'"),
      [['comment-1', 'reply-1']],
    )
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('commentcount - $2'),
      ['post-1', 2],
    )
    expect(String(client.query.mock.calls.at(-1)?.[0]).trim()).toBe('COMMIT')
  })
})
