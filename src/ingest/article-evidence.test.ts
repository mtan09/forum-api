import { afterEach, describe, expect, it } from 'vitest'
import { buildStructuredEvidence } from './article-evidence'

const previousOpenAiKey = process.env.OPENAI_API_KEY

afterEach(() => {
  if (previousOpenAiKey == null) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = previousOpenAiKey
})

describe('structured article evidence', () => {
  it('creates useful deterministic evidence without retaining source text', async () => {
    delete process.env.OPENAI_API_KEY
    const sourceText = [
      'The Senate Finance Committee debated a housing affordability proposal.',
      'Senator Maria Example said the bill would expand construction grants.',
      'The committee plans another vote in September.',
    ].join(' ')
    const evidence = await buildStructuredEvidence({
      title: 'Senate panel weighs housing affordability proposal',
      source: 'Example News',
      categories: ['Congress', 'Housing'],
      analysisText: sourceText,
      extractionMethod: 'feed',
    })

    expect(evidence.generatedBy).toBe('deterministic')
    expect(evidence.sourceTextHash).toMatch(/^[a-f0-9]{64}$/)
    expect(evidence.wordCount).toBeGreaterThan(10)
    expect(evidence.searchText).toContain('housing')
    expect(JSON.stringify(evidence)).not.toContain(sourceText)
  })

  it('still produces metadata evidence when extraction is unavailable', async () => {
    delete process.env.OPENAI_API_KEY
    const evidence = await buildStructuredEvidence({
      title: 'Governors meet over federal disaster response',
      source: 'Example News',
      categories: ['Politics'],
      analysisText: '',
      extractionMethod: 'metadata',
    })

    expect(evidence.sourceTextHash).toBeNull()
    expect(evidence.wordCount).toBe(0)
    expect(evidence.searchText).toContain('Governors')
  })
})

