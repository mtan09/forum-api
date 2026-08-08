import { describe, expect, it } from 'vitest'
import {
  POST_WEIGHT,
  VOTE_WEIGHT,
  SPECTRUM_HALF_LIFE_DAYS,
  decayedWeight,
  spectrumPosition,
  voteValue,
  type SpectrumEvent,
} from './spectrum'

const DAY_MS = 86_400_000
const at = (daysAgo: number, from = Date.UTC(2026, 0, 1)) =>
  new Date(from - daysAgo * DAY_MS)

describe('voteValue', () => {
  it('keeps the lean for an upvote and mirrors it for a downvote', () => {
    expect(voteValue('up', 0.8)).toBe(0.8)
    expect(voteValue('down', 0.8)).toBeCloseTo(0.2, 10)
  })
})

describe('decayedWeight', () => {
  it('halves at exactly one half-life', () => {
    const now = new Date(Date.UTC(2026, 0, 1))
    expect(decayedWeight(1, at(SPECTRUM_HALF_LIFE_DAYS), now)).toBeCloseTo(0.5, 10)
    expect(decayedWeight(1, at(2 * SPECTRUM_HALF_LIFE_DAYS), now)).toBeCloseTo(0.25, 10)
  })

  it('does not amplify activity dated in the future', () => {
    const now = new Date(Date.UTC(2026, 0, 1))
    expect(decayedWeight(3, at(-30), now)).toBe(3)
  })
})

describe('spectrumPosition', () => {
  it('returns 0.5 with no activity', () => {
    expect(spectrumPosition([], new Date())).toBe(0.5)
  })

  it('weights an own post above a vote', () => {
    const now = new Date(Date.UTC(2026, 0, 1))
    const events: SpectrumEvent[] = [
      { at: now, weight: POST_WEIGHT, value: 0 },
      { at: now, weight: VOTE_WEIGHT, value: 1 },
    ]
    // (3·0 + 1·1) / 4
    expect(spectrumPosition(events, now)).toBeCloseTo(0.25, 10)
  })

  it('lets recent activity outweigh old activity', () => {
    const now = new Date(Date.UTC(2026, 0, 1))
    const events: SpectrumEvent[] = [
      { at: at(3 * SPECTRUM_HALF_LIFE_DAYS), weight: VOTE_WEIGHT, value: 0 },
      { at: now, weight: VOTE_WEIGHT, value: 1 },
    ]
    // Undecayed this would be exactly 0.5; the fresh vote should dominate.
    expect(spectrumPosition(events, now)).toBeGreaterThan(0.85)
  })

  // The property the floorless curve exists to guarantee: a user who does
  // nothing has a placement that never moves. A floored decay would fail this.
  it('is invariant as time passes with no new activity', () => {
    const events: SpectrumEvent[] = [
      { at: at(0), weight: POST_WEIGHT, value: 0.2 },
      { at: at(100), weight: VOTE_WEIGHT, value: 0.8 },
      { at: at(400), weight: VOTE_WEIGHT, value: 0.55 },
    ]
    const base = new Date(Date.UTC(2026, 0, 1))
    const oneYearLater = new Date(base.getTime() + 365 * DAY_MS)
    const tenYearsLater = new Date(base.getTime() + 3650 * DAY_MS)

    expect(spectrumPosition(events, oneYearLater)).toBeCloseTo(
      spectrumPosition(events, base),
      10
    )
    expect(spectrumPosition(events, tenYearsLater)).toBeCloseTo(
      spectrumPosition(events, base),
      10
    )
  })

  // The history endpoint decays every event against one fixed reference and
  // accumulates incrementally. That is exact rather than approximate, because
  // the per-cut factor is constant across events and cancels in the ratio.
  it('matches a running accumulation weighted against a fixed reference', () => {
    const reference = new Date(Date.UTC(2026, 0, 1))
    const events: SpectrumEvent[] = [
      { at: at(300), weight: POST_WEIGHT, value: 0.1 },
      { at: at(200), weight: VOTE_WEIGHT, value: 0.9 },
      { at: at(50), weight: VOTE_WEIGHT, value: 0.4 },
    ]
    const cut = new Date(reference.getTime() - 100 * DAY_MS)
    const upTo = events.filter((event) => event.at.getTime() < cut.getTime())

    let weightedSum = 0
    let totalWeight = 0
    for (const event of upTo) {
      const weight = decayedWeight(event.weight, event.at, reference)
      weightedSum += weight * event.value
      totalWeight += weight
    }

    expect(weightedSum / totalWeight).toBeCloseTo(spectrumPosition(upTo, cut), 10)
  })
})
