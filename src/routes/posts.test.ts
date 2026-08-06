import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEnv } from '../types'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  moderateText: vi.fn(),
  moderationFailure: vi.fn(),
  matchTopic: vi.fn(),
  scorePost: vi.fn(),
  semanticEmbedding: vi.fn(),
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
  moderateText: mocks.moderateText,
  moderationFailure: mocks.moderationFailure,
}))
vi.mock('../lib/push', () => ({ notify: vi.fn() }))
vi.mock('../ingest/topics', () => ({ matchTopic: mocks.matchTopic }))
vi.mock('../scoring/score', () => ({ scorePost: mocks.scorePost }))
vi.mock('../recommendation/semantic', () => ({ semanticEmbedding: mocks.semanticEmbedding }))

import posts, { ownedUploadKey } from './posts'

const app = new Hono<AppEnv>().route('/posts', posts)

describe('post deletion', () => {
  beforeEach(() => {
    mocks.connect.mockReset()
    mocks.query.mockReset()
    mocks.moderateText.mockReset()
    mocks.moderationFailure.mockReset()
    mocks.matchTopic.mockReset()
    mocks.scorePost.mockReset()
    mocks.semanticEmbedding.mockReset()
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

describe('quote post creation', () => {
  const originalPostId = 'a87f4df3-2a8d-44ee-b327-ad57714c4c66'

  beforeEach(() => {
    mocks.query.mockReset()
    mocks.moderateText.mockReset()
    mocks.moderationFailure.mockReset()
    mocks.matchTopic.mockReset().mockResolvedValue({ generalTopicId: null })
    mocks.scorePost.mockReset().mockReturnValue({
      position: null,
      confidence: null,
      signals: [],
      scorer_version: 'test',
    })
    mocks.semanticEmbedding.mockReset().mockReturnValue([0.1, 0.2])
  })

  it('accepts a quote-only post and grounds local recommendation metadata in the original', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ content: 'Original policy argument' }] })
      .mockResolvedValueOnce({ rows: [{ id: '987221c2-feef-4021-bf7d-4aa6f0c0e5b1' }] })
      .mockResolvedValueOnce({ rows: [{ id: '987221c2-feef-4021-bf7d-4aa6f0c0e5b1' }] })

    const response = await app.request('/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoted_post_id: originalPostId }),
    })

    expect(response.status).toBe(201)
    expect(mocks.moderateText).not.toHaveBeenCalled()
    expect(mocks.matchTopic).toHaveBeenCalledWith('Original policy argument')
    expect(mocks.semanticEmbedding).toHaveBeenCalledWith('Original policy argument')
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('quoted_post_id, quoted_article_id'),
      expect.arrayContaining(['owner', originalPostId, null]),
    )
  })

  it('rejects two quote targets before reading or writing content', async () => {
    const response = await app.request('/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoted_post_id: originalPostId, quoted_article_id: originalPostId }),
    })
    expect(response.status).toBe(400)
    expect(mocks.query).not.toHaveBeenCalled()
  })
})
