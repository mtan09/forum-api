import { describe, expect, it } from 'vitest'
import {
  buildArticleMetadata,
  extractHeadlineEntities,
  metadataKeywordProfile,
} from './article-metadata'

describe('article metadata', () => {
  it('extracts useful named entities without storing article prose', () => {
    expect(
      extractHeadlineEntities('Senate challenges Trump over Iran war powers vote')
    ).toEqual(expect.arrayContaining(['Senate', 'Trump', 'Iran']))
  })

  it('builds searchable event terms from headline and feed categories', () => {
    const result = buildArticleMetadata(
      'Supreme Court hears challenge to federal immigration rule',
      'Example News',
      ['Politics', 'Immigration']
    )
    expect(result.searchText).toContain('Supreme Court')
    expect(result.searchText).toContain('Example News')
    expect(result.eventTerms.length).toBeGreaterThan(0)
    expect(result.hashtags.length).toBeGreaterThan(0)
  })

  it('retains headline entities that the broad news stoplist suppresses', () => {
    const profile = metadataKeywordProfile(
      'Trump meets Senate leaders over Iran',
      ['Trump', 'Senate', 'Iran'],
      ['war powers']
    )
    expect(profile.terms.has('entity:trump')).toBe(true)
    expect(profile.terms.has('entity:iran')).toBe(true)
  })
})
