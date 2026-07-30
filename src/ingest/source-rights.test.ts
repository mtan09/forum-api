import { describe, expect, it } from 'vitest'
import { SOURCES } from './sources'
import { missingSourceRights, rightsForSource } from './source-rights'

describe('source rights registry', () => {
  it('covers every curated source', () => {
    expect(missingSourceRights(SOURCES.map((source) => source.slug))).toEqual([])
  })

  it('denies article-page, body, AI-text, and image use by default', () => {
    expect(rightsForSource('unknown-source')).toMatchObject({
      acquisition: 'feed_metadata',
      publicText: 'headline_only',
      analysis: 'metadata_only',
      ai: 'metadata_only',
      image: 'none',
    })
  })
})
