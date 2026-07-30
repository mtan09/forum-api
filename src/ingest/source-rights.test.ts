import { describe, expect, it } from 'vitest'
import { SOURCES } from './sources'
import { missingSourceRights, rightsForSource } from './source-rights'

describe('source rights registry', () => {
  it('covers every curated source', () => {
    expect(missingSourceRights(SOURCES.map((source) => source.slug))).toEqual([])
  })

  it('keeps unregistered sources metadata-only while allowing remote preview fallback', () => {
    expect(rightsForSource('unknown-source')).toMatchObject({
      acquisition: 'feed_metadata',
      publicText: 'headline_only',
      analysis: 'metadata_only',
      ai: 'metadata_only',
      image: 'remote_no_cache',
    })
  })

  it('uses transient analysis and structured evidence for curated sources', () => {
    expect(rightsForSource('the-hill')).toMatchObject({
      acquisition: 'full_page',
      publicText: 'headline_only',
      analysis: 'full_page_transient',
      ai: 'structured_evidence',
      image: 'managed_thumbnail',
    })
  })
})
