import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../db', () => ({ query: mocks.query }))

import { personalizedFeed } from './service'

describe('personalized feed repost distribution', () => {
  beforeEach(() => {
    mocks.query.mockReset().mockResolvedValue({ rows: [] })
  })

  it('enables accepted-follow repost candidates only for For You', async () => {
    await personalizedFeed({
      userId: 'viewer', mode: 'for_you', content: 'posts', limit: 20,
      requestedSessionId: 'for-you-session',
    })
    const forYouCandidate = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes('WITH candidate_ids AS') && String(sql).includes('r.post_id'))
    expect(forYouCandidate).toBeTruthy()
    expect(forYouCandidate?.[1]?.[3]).toBe(true)
    expect(String(forYouCandidate?.[0])).toContain('reposted_by_username')

    mocks.query.mockClear()
    await personalizedFeed({
      userId: 'viewer', mode: 'random', content: 'posts', limit: 20,
      requestedSessionId: 'random-session',
    })
    const randomCandidate = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes('WITH candidate_ids AS') && String(sql).includes('r.post_id'))
    expect(randomCandidate?.[1]?.[3]).toBe(false)
  })
})
