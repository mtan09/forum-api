import { describe, expect, it } from 'vitest'
import { searchPhrases, searchTerms } from './search-query'

describe('search query metadata helpers', () => {
  it('removes stop words and duplicate terms', () => {
    expect(searchTerms('The Iran war and the war powers vote')).toEqual([
      'iran', 'war', 'powers', 'vote',
    ])
  })

  it('creates adjacent event phrases without loose combinations', () => {
    expect(searchPhrases(['congress', 'war', 'powers'])).toEqual([
      'congress war',
      'war powers',
    ])
  })

  it('does not create phrase fallback for a single meaningful term', () => {
    expect(searchPhrases(['trump'])).toEqual([])
  })
})
