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

  it('leaves text without directional evidence unclassified', () => {
    const result = scorePost('I had a sandwich for lunch and then walked the dog around the park.')
    expect(result.position).toBeNull()
  })

  it('left-framing vocabulary moves the score left of center', () => {
    const result = scorePost(
      'Congress must protect every undocumented immigrant and strengthen the estate tax to fund climate crisis action.'
    )
    expect(result.position).not.toBeNull()
    expect(result.position).toBeLessThan(0.5)
  })

  it('right-framing vocabulary moves the score right of center', () => {
    const result = scorePost(
      'The death tax punishes family farms while illegal aliens strain the border — Washington ignores both.'
    )
    expect(result.position).not.toBeNull()
    expect(result.position).toBeGreaterThan(0.5)
  })

  it('recognizes a left-aligned war-powers stance without partisan slogans', () => {
    const result = scorePost(
      'Two soldiers are dead. Congress has not voted on any of this. War powers exist for a reason — where is the authorization debate?'
    )
    expect(result.position).toBeLessThan(0.4)
    expect(result.signals).toContain(
      'stance-left:"foreign policy · war requires congressional authorization"×1'
    )
  })

  it('recognizes a right-aligned border-enforcement stance without partisan slogans', () => {
    const result = scorePost(
      'A country that cannot control its borders is not a country. We need to enforce the border consistently.'
    )
    expect(result.position).toBeGreaterThan(0.6)
    expect(result.signals).toContain(
      'stance-right:"immigration · stricter border enforcement"×1'
    )
  })

  it('does not mistake analysis mentioning strict voter-ID states for support', () => {
    const result = scorePost(
      'Strict voter ID states and loose ones have nearly identical turnout. Both parties are fighting over a rounding error.'
    )
    expect(result.position).toBeNull()
    expect(result.signals.some((signal) => signal.startsWith('stance-right:'))).toBe(false)
  })

  it('reserves center for genuinely mixed directional evidence', () => {
    const result = scorePost(
      'Congress should secure the border and create a path to citizenship for DACA recipients.'
    )
    expect(result.position).toBe(0.5)
    expect(result.signals.some((signal) => signal.startsWith('stance-left:'))).toBe(true)
    expect(result.signals.some((signal) => signal.startsWith('stance-right:'))).toBe(true)
  })

  it.each([
    ['Prior authorization delays care while insurers profit from every denial.', 'left'],
    ['Workers deserve a union and Congress should raise the minimum wage.', 'left'],
    ['Climate risk is hitting insurance bills; we must reduce carbon emissions.', 'left'],
    ['Health care is a human right. Medicare for All should replace insurance denials.', 'left'],
    ['Congress should protect abortion access and reproductive freedom nationwide.', 'left'],
    ['I support universal background checks and Congress should ban assault weapons.', 'left'],
    ['Create a path to citizenship for DACA recipients and expand legal immigration pathways.', 'left'],
    ['Peace through strength is the only deterrence hostile regimes understand.', 'right'],
    ['Student loan forgiveness is a regressive giveaway to future high earners.', 'right'],
    ['We should cut government spending and lower corporate taxes.', 'right'],
    ['Parents should choose their school, and states should expand school vouchers.', 'right'],
    ['Cities should fund the police, hire more officers, and impose tougher sentences.', 'right'],
    ['America should drill more oil, approve pipelines, and expand domestic energy production.', 'right'],
    ['States should restrict abortion and protect unborn life.', 'right'],
    ['Government-run health care should give way to health care choice and market competition.', 'right'],
    ['A nationwide minimum wage kills jobs in towns where small businesses cannot absorb it.', 'right'],
  ])('places substantive policy stance: %s', (text, expected) => {
    const result = scorePost(text)
    expect(result.position).not.toBeNull()
    if (expected === 'left') expect(result.position).toBeLessThan(0.4)
    else expect(result.position).toBeGreaterThan(0.6)
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
    expect(result.position).not.toBeNull()
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
