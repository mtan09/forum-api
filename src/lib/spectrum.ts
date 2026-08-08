// A user's political placement, computed from their activity — never
// self-declared. One implementation, three call sites: GET /users/me/spectrum,
// GET /users/me/spectrum/history, and the feed's recommendation profile
// (recommendation/service.ts). They must not drift apart.
//
// Model:
//   - each of the user's own scored posts contributes its position, weight 3
//   - each upvote contributes the voted item's lean, weight 1
//   - each downvote contributes the MIRROR of that lean (1 - lean), weight 1
//   - unscored content contributes nothing; votes on your own posts are excluded
//   position = Σ(weight · value) / Σ(weight),  0.5 when there is no activity.

const DAY_MS = 86_400_000

// Recent activity should outweigh old activity, so a user whose views change is
// not averaged forever against who they used to be.
//
// Deliberately floorless. Pure exponential decay is time-invariant: advancing
// time by Δ scales every weight by the same 0.5^(Δ/H), and that factor cancels
// between numerator and denominator — so a user who does nothing has a placement
// that never moves. A floor would break that (floored items stop shrinking while
// newer ones keep shrinking) and make the number drift with no user action.
export const SPECTRUM_HALF_LIFE_DAYS = 365

export const POST_WEIGHT = 3
export const VOTE_WEIGHT = 1

export type SpectrumEvent = {
  at: Date
  weight: number
  value: number
}

const toMs = (value: Date | string | number): number =>
  value instanceof Date ? value.getTime() : new Date(value).getTime()

/** Base weight scaled by age. `asOf` is the reference instant. */
export function decayedWeight(
  baseWeight: number,
  at: Date | string | number,
  asOf: Date | string | number
): number {
  const ageDays = Math.max(0, (toMs(asOf) - toMs(at)) / DAY_MS)
  return baseWeight * Math.pow(0.5, ageDays / SPECTRUM_HALF_LIFE_DAYS)
}

/**
 * Weighted placement over `events` as of `asOf`.
 *
 * Because decay is time-invariant, callers replaying a timeline may compute
 * every weight against a single fixed reference and still get the correct value
 * at each intermediate cut: the per-cut factor is constant across events and
 * cancels in the ratio.
 */
export function spectrumPosition(
  events: SpectrumEvent[],
  asOf: Date | string | number
): number {
  let weightedSum = 0
  let totalWeight = 0
  for (const event of events) {
    const weight = decayedWeight(event.weight, event.at, asOf)
    weightedSum += weight * event.value
    totalWeight += weight
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0.5
}

/** Turn a vote row into its contribution: up keeps the lean, down mirrors it. */
export const voteValue = (direction: string, lean: number): number =>
  direction === 'up' ? lean : 1 - lean
