import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEnv } from '../types'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
}))

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
vi.mock('../lib/moderation', () => ({
  moderateText: vi.fn(),
  moderationFailure: vi.fn(),
}))
vi.mock('../lib/push', () => ({ notify: vi.fn() }))
vi.mock('../ingest/topics', () => ({ matchTopic: vi.fn() }))
vi.mock('../scoring/score', () => ({ scorePost: vi.fn() }))
vi.mock('../recommendation/semantic', () => ({ semanticEmbedding: vi.fn() }))

import posts, { ownedUploadKey } from './posts'

const app = new Hono<AppEnv>().route('/posts', posts)

describe('post deletion', () => {
  beforeEach(() => {
    mocks.connect.mockReset()
    mocks.query.mockReset()
    process.env.R2_PUBLIC_URL = 'https://media.forum.test/public'
  })

  it('only identifies exact media objects owned by the post author', () => {
    expect(ownedUploadKey('https://media.forum.test/public/owner/123-photo.jpg', 'owner'))
      .toBe('owner/123-photo.jpg')
    expect(ownedUploadKey('https://media.forum.test/public/another/123-photo.jpg', 'owner'))
      .toBeNull()
    expect(ownedUploadKey('https://publisher.test/owner/123-photo.jpg', 'owner')).toBeNull()
    expect(ownedUploadKey('https://media.forum.test/public/owner/../secret.jpg', 'owner')).toBeNull()
  })

  it('rejects deletion by someone other than the author', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ user_id: 'another', media_url: null }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)

    const response = await app.request('/posts/47dd61db-9ff7-4655-8e1a-332ed366d680', {
      method: 'DELETE',
    })

    expect(response.status).toBe(403)
    expect(client.query.mock.calls.map(([sql]) => String(sql).trim())).toEqual([
      'BEGIN',
      expect.stringContaining('SELECT user_id, media_url'),
      'ROLLBACK',
    ])
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('tombstones shares, clears reports, and queues only the post media before deletion', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{
          user_id: 'owner',
          media_url: 'https://media.forum.test/public/owner/123-photo.jpg',
        }] })
        .mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    mocks.connect.mockResolvedValue(client)

    const id = '47dd61db-9ff7-4655-8e1a-332ed366d680'
    const response = await app.request(`/posts/${id}`, { method: 'DELETE' })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ deleted: true, id })
    const statements = client.query.mock.calls.map(([sql]) => String(sql))
    expect(statements.some((sql) => sql.includes('UPDATE messages'))).toBe(true)
    expect(statements.some((sql) => sql.includes('DELETE FROM reports'))).toBe(true)
    expect(statements.some((sql) => sql.includes('INSERT INTO media_deletion_jobs'))).toBe(true)
    expect(statements.some((sql) => sql.includes('DELETE FROM posts'))).toBe(true)
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO media_deletion_jobs'),
      ['owner/123-photo.jpg'],
    )
    expect(String(client.query.mock.calls.at(-1)?.[0]).trim()).toBe('COMMIT')
  })
})
