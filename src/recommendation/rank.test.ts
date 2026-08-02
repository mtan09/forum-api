import { describe, expect, it } from 'vitest'
import { interestEmbedding, semanticEmbedding } from './semantic'
import {
  diversify,
  rankCandidates,
  type RecommendationCandidate,
  type RecommendationProfile,
} from './rank'

const snapshot = new Date('2026-08-01T12:00:00.000Z')

function candidate(
  id: string,
  overrides: Partial<RecommendationCandidate> = {}
): RecommendationCandidate {
  return {
    kind: 'article',
    id,
    timestamp: new Date('2026-08-01T10:00:00.000Z'),
    lean: 0.5,
    topicId: id,
    sourceKey: id,
    authorId: null,
    embedding: semanticEmbedding('general politics'),
    upvotes: 3,
    downvotes: 0,
    comments: 1,
    impressions: 20,
    opens: 5,
    averageDwellMs: 8_000,
    followed: false,
    sourceAffinity: 0,
    recentlySeen: false,
    data: { id },
    ...overrides,
  }
}

const profile: RecommendationProfile = {
  position: 0.25,
  explicitVector: interestEmbedding('housing'),
  behaviorVector: interestEmbedding('housing'),
  selectedInterestLabels: ['Housing'],
}

describe('hybrid feed ranking', () => {
  it('prioritizes personally relevant material in For You', () => {
    const housing = candidate('housing', {
      embedding: semanticEmbedding('Rent, mortgages, zoning, and affordable housing'),
    })
    const unrelated = candidate('unrelated', {
      embedding: semanticEmbedding('Cybersecurity software and semiconductor manufacturing'),
    })
    const ranked = rankCandidates({ candidates: [unrelated, housing], profile, mode: 'for_you', seed: 'stable', snapshot })
    expect(ranked[0].id).toBe('housing')
    expect(ranked[0].reason).toContain('Housing')
  })

  it('gives substantive opposing content a strong Against You signal', () => {
    const left = candidate('left', { lean: 0.2 })
    const right = candidate('right', { lean: 0.8 })
    const ranked = rankCandidates({ candidates: [left, right], profile, mode: 'against', seed: 'stable', snapshot })
    expect(ranked.find((item) => item.id === 'right')?.signals.perspective).toBe(1)
    expect(ranked.find((item) => item.id === 'left')?.signals.perspective).toBeLessThan(0.1)
  })

  it('is stable for the same snapshot and seed', () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(String(index)))
    const first = rankCandidates({ candidates, profile, mode: 'random', seed: 'session-1', snapshot })
    const second = rankCandidates({ candidates, profile, mode: 'random', seed: 'session-1', snapshot })
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id))
  })

  it('softens content-type runs only when the alternatives are similarly ranked', () => {
    const ranked = Array.from({ length: 4 }, (_, index) => ({
      ...candidate(`article-${index}`),
      score: 1 - index * 0.01,
      reason: 'test',
      signals: {},
    })).concat([{
      ...candidate('comparable-post', { kind: 'post' }),
      score: 0.95,
      reason: 'test',
      signals: {},
    }])
    const result = diversify(ranked, 'for_you')
    expect(result.slice(0, 3).map((item) => item.id)).toContain('comparable-post')
  })

  it('does not reserve feed space for a weak post when articles rank much higher', () => {
    const ranked = Array.from({ length: 4 }, (_, index) => ({
      ...candidate(`strong-article-${index}`),
      score: 1 - index * 0.01,
      reason: 'test',
      signals: {},
    })).concat([{
      ...candidate('weak-post', { kind: 'post' }),
      score: 0.1,
      reason: 'test',
      signals: {},
    }])
    const result = diversify(ranked, 'for_you')
    expect(result.slice(0, 4).every((item) => item.kind === 'article')).toBe(true)
  })
})
