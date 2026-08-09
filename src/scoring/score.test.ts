import { describe, expect, it } from 'vitest'
import { POST_SCORING_EVALUATION } from './evaluation-corpus'
import { scorePost, scoreArticle, SCORER_VERSION } from './score'

// The scorer is the app's core promise: deterministic, no black box.
// These tests pin that promise down.
describe('scorePost', () => {
  it('meets the reviewed corpus coverage and false-placement thresholds', () => {
    const band = (position: number | null) => {
      if (position == null) return 'unclassified'
      if (position < 0.45) return 'left'
      if (position > 0.55) return 'right'
      return 'center'
    }
    const results = POST_SCORING_EVALUATION.map((entry) => ({
      expected: entry.label,
      actual: band(scorePost(entry.text).position),
    }))
    const directional = results.filter((entry) => entry.expected === 'left' || entry.expected === 'right')
    const directionalMatches = directional.filter((entry) => entry.actual === entry.expected).length
    const neutral = results.filter((entry) => entry.expected === 'unclassified')
    const falsePlacements = neutral.filter((entry) => entry.actual !== 'unclassified').length
    const center = results.filter((entry) => entry.expected === 'center')
    const centerMatches = center.filter((entry) => entry.actual === 'center').length

    expect(directionalMatches / directional.length).toBeGreaterThanOrEqual(0.9)
    expect(centerMatches / center.length).toBeGreaterThanOrEqual(2 / 3)
    expect(falsePlacements / neutral.length).toBeLessThanOrEqual(0.05)
  })

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

  // Naming a statute is not a position: both coalitions use "estate tax" and
  // "Affordable Care Act", and the author may be about to argue against the
  // thing they just named. Treating those names as placement signals is what
  // scored "the Affordable Care Act should be repealed" LEFT of centre.
  it('does not place a post on policy names alone', () => {
    const result = scorePost(
      'The estate tax and the Affordable Care Act both came up at the town hall last night.'
    )
    expect(result.position).toBeNull()
    expect(result.null_reason).toBe('no-claim')
  })

  it('reads a repeal of a neutrally-named statute as opposing it', () => {
    const result = scorePost('The Affordable Care Act should be repealed.')
    expect(result.position).not.toBeNull()
    expect(result.position!).toBeGreaterThan(0.55)
  })

  // Epithets are the other half of the lexicon and DO place a post. Nobody
  // reaches for "woke administrators" about their own coalition, so the word
  // choice is the alignment even when no policy is proposed.
  it('places a post that only disparages the other coalition', () => {
    const right = scorePost(
      'Cancel culture is out of control on campus. Woke administrators police every word.'
    )
    expect(right.position).not.toBeNull()
    expect(right.position!).toBeGreaterThan(0.55)

    const left = scorePost(
      'The climate crisis will not wait. Big oil keeps blocking progress and buying senators.'
    )
    expect(left.position).not.toBeNull()
    expect(left.position!).toBeLessThan(0.45)
  })

  it('framing vocabulary still intensifies a position the text states', () => {
    const plain = scorePost('Congress should abolish the estate tax.')
    const framed = scorePost('Congress should abolish the death tax and end this assault on job creators.')
    expect(plain.position).not.toBeNull()
    expect(framed.position).not.toBeNull()
    expect(framed.position!).toBeGreaterThan(plain.position!)
  })

  it('recognizes a left-aligned war-powers stance without partisan slogans', () => {
    const result = scorePost(
      'Two soldiers are dead. Congress has not voted on any of this. War powers exist for a reason — where is the authorization debate?'
    )
    expect(result.position).toBeLessThan(0.4)
    expect(result.signals).toContain('claim:"war-powers-constraint · more"×1')
  })

  it('recognizes a right-aligned border-enforcement stance without partisan slogans', () => {
    const result = scorePost(
      'A country that cannot control its borders is not a country. We need to enforce the border consistently.'
    )
    expect(result.position).toBeGreaterThan(0.6)
    expect(result.signals).toContain('claim:"immigration-enforcement · more"×1')
  })

  it('recognizes compositional labor language from a natural demo post', () => {
    const result = scorePost(
      'Who is guaranteeing union labor standards and apprenticeship slots before the rebuilding plan moves forward?'
    )
    expect(result.position).not.toBeNull()
    expect(result.position).toBeLessThan(0.4)
    expect(result.signals.some((signal) =>
      signal.startsWith('claim-meta:') && signal.includes('compositional')
    )).toBe(true)
  })

  it('recognizes local prototype paraphrases without sending text to a model', () => {
    const result = scorePost(
      'We should regulate carbon pollution and fossil fuels instead of accepting another decade of delay.'
    )
    expect(result.position).not.toBeNull()
    expect(result.position).toBeLessThan(0.4)
    expect(result.signals.some((signal) =>
      signal.startsWith('claim-meta:') && signal.includes('climate-action')
    )).toBe(true)
  })

  it('recognizes investment in local public-health capacity', () => {
    const result = scorePost(
      'The next administration should fund ventilation upgrades, contact tracing capacity, and transparent data sharing with counties.'
    )
    expect(result.position).not.toBeNull()
    expect(result.position).toBeLessThan(0.4)
  })

  it('does not score a third-party position that the author expressly disclaims', () => {
    const result = scorePost(
      'A reporter said the governor wants to expand domestic oil production, but I have not taken a position.'
    )
    expect(result.position).toBeNull()
  })

  // Opposition used to delete the match, so this scored nothing at all. It is
  // now a polarity flip: the claim is still about labor-power, but the author
  // wants less of it, which places them right.
  it('treats opposition to a left proposal as the opposing position', () => {
    const result = scorePost(
      'I oppose the proposal to strengthen union labor standards because employers cannot absorb another mandate.'
    )
    expect(result.position).not.toBeNull()
    expect(result.position!).toBeGreaterThan(0.55)
    expect(result.signals.some((s) =>
      s.startsWith('claim-meta:') && s.includes('"polarity":"against"')
    )).toBe(true)
  })

  it('leaves non-directional institutional accountability questions unclassified', () => {
    const result = scorePost(
      'Congress should demand a public audit, publish the chain of command, and explain who approved the fund.'
    )
    expect(result.position).toBeNull()
  })

  it('does not mistake analysis mentioning strict voter-ID states for support', () => {
    const result = scorePost(
      'Strict voter ID states and loose ones have nearly identical turnout. Both parties are fighting over a rounding error.'
    )
    expect(result.position).toBeNull()
    expect(result.signals.some((signal) => signal.startsWith('claim:"'))).toBe(false)
  })

  it('reserves center for genuinely mixed directional evidence', () => {
    const result = scorePost(
      'Congress should secure the border and create a path to citizenship for DACA recipients.'
    )
    expect(result.position).toBe(0.5)
    // Centre must come from two opposing claims cancelling, never from an
    // absence of evidence — that is what `null` is for.
    expect(result.signals.some((s) => s.includes('immigration-enforcement'))).toBe(true)
    expect(result.signals.some((s) => s.includes('immigration-openness'))).toBe(true)
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

  it('keeps position and confidence in [0, 1] under piled-up evidence', () => {
    const extreme = Array(50)
      .fill('Congress should abolish the death tax and cut corporate taxes.')
      .join(' ')
    const result = scorePost(extreme)
    expect(result.position).not.toBeNull()
    expect(result.position).toBeGreaterThanOrEqual(0)
    expect(result.position).toBeLessThanOrEqual(1)
    expect(result.confidence).toBeGreaterThanOrEqual(0)
    expect(result.confidence).toBeLessThanOrEqual(1)
  })

  it('records why an unplaced post is unplaced', () => {
    expect(scorePost('Wow').null_reason).toBe('no-claim')
    // Trade has genuinely swapped coalitions, so refusing is the answer.
    expect(scorePost('We should impose new tariffs on Chinese steel.').null_reason)
      .toBe('contested')
    // An actor claim with no story context resolves to nothing, but is
    // reported separately from "recognised nothing at all".
    expect(scorePost('I support Blanche’s confirmation.').null_reason)
      .toBe('unmapped-actor')
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
