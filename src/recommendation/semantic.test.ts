import { describe, expect, it } from 'vitest'
import {
  cosineSimilarity,
  interestEmbedding,
  semanticEmbedding,
  SEMANTIC_DIMENSIONS,
  validInterestKeys,
} from './semantic'

describe('local semantic recommendations', () => {
  it('is deterministic and fixed-width', () => {
    const text = 'Congress debates health insurance and Medicare costs.'
    expect(semanticEmbedding(text)).toEqual(semanticEmbedding(text))
    expect(semanticEmbedding(text)).toHaveLength(SEMANTIC_DIMENSIONS)
  })

  it('maps synonymous policy language closer than unrelated coverage', () => {
    const healthcare = interestEmbedding('healthcare')
    const medicine = semanticEmbedding('Hospitals, Medicare coverage, insurance premiums, and drug prices')
    const cybersecurity = semanticEmbedding('A software vulnerability affected cloud computing and encryption')
    expect(cosineSimilarity(healthcare, medicine)).toBeGreaterThan(
      cosineSimilarity(healthcare, cybersecurity)
    )
  })

  it('accepts only durable catalog interests and removes duplicates', () => {
    expect(validInterestKeys(['economy', 'economy', 'housing', 'Troy Jackson'])).toEqual([
      'economy',
      'housing',
    ])
  })
})
