import { describe, expect, it } from 'vitest'
import { scorePost, scoreArticle, SCORER_VERSION } from './score'

// The scorer is the app's core promise: deterministic, no black box.
// These tests pin that promise down.
describe('scorePost', () => {
  it('is deterministic — same text, same placement, always', () => {
    const text =
      'The estate tax debate returns as Congress weighs undocumented immigrant protections.'
    const a = scorePost(text)
    const b = scorePost(text)
    expect(a).toEqual(b)
  })

  it('places neutral text at center', () => {
    const result = scorePost('I had a sandwich for lunch and then walked the dog around the park.')
    expect(result.position).toBeCloseTo(0.5, 1)
  })

  it('left-framing vocabulary moves the score left of center', () => {
    const result = scorePost(
      'Congress must protect every undocumented immigrant and strengthen the estate tax to fund climate crisis action.'
    )
    expect(result.position).toBeLessThan(0.5)
  })

  it('right-framing vocabulary moves the score right of center', () => {
    const result = scorePost(
      'The death tax punishes family farms while illegal aliens strain the border — Washington ignores both.'
    )
    expect(result.position).toBeGreaterThan(0.5)
  })

  it('stamps every score with the scorer version and receipts', () => {
    const result = scorePost('The death tax must be repealed now.')
    expect(result.scorer_version).toBe(SCORER_VERSION)
    expect(result.signals).toContain(`scorer:${SCORER_VERSION}`)
    expect(result.signals.some((s) => s.startsWith('right:'))).toBe(true)
  })

  it('keeps position and confidence in [0, 1]', () => {
    const extreme = Array(50).fill('death tax illegal alien radical left').join(' ')
    const result = scorePost(extreme)
    expect(result.position).toBeGreaterThanOrEqual(0)
    expect(result.position).toBeLessThanOrEqual(1)
    expect(result.confidence).toBeGreaterThanOrEqual(0)
    expect(result.confidence).toBeLessThanOrEqual(1)
  })
})

describe('scoreArticle', () => {
  it('starts from the outlet prior and shifts at most a bounded amount', () => {
    const prior = 0.3
    const result = scoreArticle({
      title: 'Senate passes budget bill',
      content:
        'The Senate voted 52-48 on Tuesday to pass the budget bill. The measure now heads to the House, where leaders said a vote is expected next week.',
      sourcePrior: prior,
      url: 'https://example.com/politics/senate-budget',
    })
    // straight news copy shouldn't drag far from the outlet prior
    expect(Math.abs(result.political_lean - prior)).toBeLessThanOrEqual(0.25)
    expect(result.lean_signals).toContain(`prior:${prior.toFixed(2)}`)
  })

  it('is deterministic for articles too', () => {
    const input = {
      title: 'Opinion: the death tax must go',
      content: 'I believe the death tax is outrageous and every family farm suffers under it.',
      sourcePrior: 0.7,
      url: 'https://example.com/opinion/death-tax',
    }
    expect(scoreArticle(input)).toEqual(scoreArticle(input))
  })
})
