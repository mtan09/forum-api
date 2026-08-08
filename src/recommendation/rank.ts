import { createHash } from 'node:crypto'
import { cosineSimilarity } from './semantic'

export const FEED_ALGORITHM_VERSION = 'hybrid-1.0.0'
export type FeedMode = 'for_you' | 'random' | 'against'
export type ContentPreference = 'all' | 'posts' | 'articles'
export type CandidateKind = 'post' | 'article'

export type RecommendationCandidate = {
  kind: CandidateKind
  id: string
  timestamp: Date
  lean: number | null
  topicId: string | null
  sourceKey: string
  authorId: string | null
  embedding: number[]
  upvotes: number
  downvotes: number
  comments: number
  impressions: number
  opens: number
  averageDwellMs: number
  followed: boolean
  sourceAffinity: number
  recentlySeen: boolean
  data: Record<string, unknown>
}

export type RecommendationProfile = {
  position: number
  explicitVector: number[]
  behaviorVector: number[]
  selectedInterestLabels: string[]
}

export type RankedCandidate = RecommendationCandidate & {
  score: number
  reason: string
  signals: Record<string, number>
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

function deterministicNoise(seed: string, candidate: RecommendationCandidate): number {
  const digest = createHash('sha256')
    .update(`${seed}:${candidate.kind}:${candidate.id}`)
    .digest()
  return digest.readUInt32BE(0) / 0xffffffff
}

function freshness(candidate: RecommendationCandidate, snapshot: Date): number {
  const ageHours = Math.max(0, snapshot.getTime() - candidate.timestamp.getTime()) / 3_600_000
  const halfLife = candidate.kind === 'article' ? 18 : 48
  return Math.pow(0.5, ageHours / halfLife)
}

function quality(candidate: RecommendationCandidate): number {
  // A small Bayesian prior keeps a brand-new item viable while preventing a
  // single early open from beating content with sustained positive behavior.
  const openRate = (candidate.opens + 2) / (candidate.impressions + 12)
  const dwell = clamp01(Math.log1p(candidate.averageDwellMs / 1_000) / Math.log(31))
  const community = clamp01(
    Math.log1p(candidate.upvotes + candidate.comments * 1.5) / Math.log(40)
  )
  const controversyPenalty = clamp01(candidate.downvotes / Math.max(6, candidate.upvotes + candidate.downvotes))
  return clamp01(openRate * 0.35 + dwell * 0.25 + community * 0.4 - controversyPenalty * 0.12)
}

function perspective(mode: FeedMode, user: number, item: number | null): number {
  // Unknown lean is neutral, not bad. Every article carries a lean (source_lean
  // always backfills), so a penalty here only ever lands on posts — 40% of which
  // are unclassified. Scoring them below a merely-mismatched article made the
  // scorer's own coverage gap into a ranking penalty.
  if (item == null) return mode === 'random' ? 0.6 : 0.5
  const userCentered = Math.abs(user - 0.5) <= 0.05
  const itemCentered = Math.abs(item - 0.5) <= 0.05
  if (mode === 'random') return 0.5
  if (mode === 'against') {
    if (userCentered) return itemCentered ? 0.2 : clamp01(Math.abs(item - 0.5) * 2)
    const opposite = user < 0.5 ? item > 0.55 : item < 0.45
    return opposite ? 1 : itemCentered ? 0.35 : 0.05
  }
  if (userCentered) return itemCentered ? 1 : 0.72
  const similarity = 1 - Math.abs(user - item)
  return itemCentered ? Math.max(0.78, similarity) : clamp01(similarity)
}

function reasonFor(
  mode: FeedMode,
  candidate: RecommendationCandidate,
  signals: Record<string, number>,
  profile: RecommendationProfile
): string {
  if (mode === 'against' && signals.perspective >= 0.8) {
    return 'A different perspective on a topic relevant to you'
  }
  if (candidate.followed) return 'From someone you follow'
  if (signals.explicitInterest >= 0.45 && profile.selectedInterestLabels.length > 0) {
    return `Related to ${profile.selectedInterestLabels[0]}`
  }
  if (signals.semantic >= 0.4) return 'Similar to things you have explored'
  if (signals.quality >= 0.6 && signals.freshness >= 0.35) return 'Gaining attention now'
  if (signals.novelty >= 0.8) return 'Explore something new'
  return mode === 'random' ? 'A fresh perspective from across forum' : 'Recommended for you'
}

export function rankCandidates(input: {
  candidates: RecommendationCandidate[]
  profile: RecommendationProfile
  mode: FeedMode
  seed: string
  snapshot: Date
}): RankedCandidate[] {
  const { candidates, profile, mode, seed, snapshot } = input
  const weights = mode === 'for_you'
    ? { explicitInterest: 0.20, semantic: 0.20, freshness: 0.15, social: 0.10, quality: 0.13, perspective: 0.09, source: 0.05, novelty: 0.04, exploration: 0.04 }
    : mode === 'against'
      ? { explicitInterest: 0.18, semantic: 0.22, freshness: 0.14, social: 0.03, quality: 0.17, perspective: 0.19, source: 0.02, novelty: 0.02, exploration: 0.03 }
      : { explicitInterest: 0.04, semantic: 0.04, freshness: 0.22, social: 0.03, quality: 0.20, perspective: 0.00, source: 0.02, novelty: 0.20, exploration: 0.25 }

  const ranked = candidates.map((candidate): RankedCandidate => {
    const explicitInterest = cosineSimilarity(profile.explicitVector, candidate.embedding)
    const semantic = cosineSimilarity(profile.behaviorVector, candidate.embedding)
    const itemFreshness = freshness(candidate, snapshot)
    const itemQuality = quality(candidate)
    const itemPerspective = perspective(mode, profile.position, candidate.lean)
    const signals = {
      explicitInterest,
      semantic,
      freshness: itemFreshness,
      social: candidate.followed ? 1 : 0,
      quality: itemQuality,
      perspective: itemPerspective,
      source: clamp01(candidate.sourceAffinity),
      novelty: candidate.recentlySeen ? 0 : 1,
      exploration: deterministicNoise(seed, candidate),
    }
    // Posts have no outlet, so `source` is not a signal they can ever earn —
    // scoring both kinds out of the full weight mass charged posts for the
    // absence. An article scoring 0 on source is a measurement ("this reader
    // ignores that outlet"); a post scoring 0 is not applicable. Divide by the
    // mass each kind can actually reach.
    const applicable = candidate.kind === 'post' ? 1 - weights.source : 1
    const score = Object.entries(weights).reduce(
      (sum, [key, weight]) => sum + signals[key as keyof typeof signals] * weight,
      0
    ) / applicable
    return {
      ...candidate,
      score,
      signals,
      reason: reasonFor(mode, candidate, signals, profile),
    }
  })

  ranked.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  return diversify(ranked, mode)
}

function leanBand(lean: number | null): 'left' | 'center' | 'right' | 'unknown' {
  if (lean == null) return 'unknown'
  if (lean < 0.45) return 'left'
  if (lean > 0.55) return 'right'
  return 'center'
}

// Greedy re-ranking applies light timeline-level diversity after individual
// relevance scoring. Content type is never quota-controlled: a post only moves
// ahead of an article (or vice versa) when their scores are already comparable.
export function diversify(ranked: RankedCandidate[], mode: FeedMode): RankedCandidate[] {
  const remaining = [...ranked]
  const result: RankedCandidate[] = []
  const bandCounts = { left: 0, center: 0, right: 0, unknown: 0 }

  while (remaining.length > 0) {
    const recent = result.slice(-6)
    const lastTwo = result.slice(-2)
    const repeatedKind = lastTwo.length === 2 && lastTwo[0].kind === lastTwo[1].kind
      ? lastTwo[0].kind
      : null
    const bestOtherKindScore = repeatedKind == null
      ? null
      : remaining.reduce<number | null>(
          (best, item) => item.kind === repeatedKind
            ? best
            : Math.max(best ?? -Infinity, item.score),
          null
        )
    let bestIndex = 0
    let bestAdjusted = -Infinity
    for (let index = 0; index < remaining.length; index++) {
      const item = remaining[index]
      let adjusted = item.score
      if (
        repeatedKind != null &&
        item.kind === repeatedKind &&
        bestOtherKindScore != null &&
        bestOtherKindScore >= item.score - 0.12
      ) {
        adjusted -= 0.08
      }
      if (recent.filter((entry) => entry.sourceKey === item.sourceKey).length >= 2) adjusted -= 0.24
      if (item.topicId && result.slice(-3).some((entry) => entry.topicId === item.topicId)) adjusted -= 0.10
      if (mode === 'random') {
        const band = leanBand(item.lean)
        const minimum = Math.min(...Object.values(bandCounts))
        if (bandCounts[band] === minimum) adjusted += 0.13
      }
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted
        bestIndex = index
      }
    }
    const [selected] = remaining.splice(bestIndex, 1)
    result.push(selected)
    bandCounts[leanBand(selected.lean)]++
  }
  return result
}
