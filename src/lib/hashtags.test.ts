import { describe, expect, it } from 'vitest'
import { normalizeHashtags } from './hashtags'

describe('normalizeHashtags', () => {
  it('merges provided tags with inline #tags, deduped', () => {
    expect(normalizeHashtags(['Economy'], 'Thoughts on #economy and #Taxes')).toEqual([
      'economy',
      'taxes',
    ])
  })

  it('normalizes to lowercase slugs and strips punctuation', () => {
    expect(normalizeHashtags(['Foreign-Policy!'], '')).toEqual(['foreignpolicy'])
  })

  it('drops tags that are too short after cleaning', () => {
    expect(normalizeHashtags(['a', '!!'], '')).toEqual([])
  })

  it('caps at 8 tags', () => {
    const many = Array.from({ length: 12 }, (_, i) => `tag${i}`)
    expect(normalizeHashtags(many, '')).toHaveLength(8)
  })

  it('ignores non-array provided values', () => {
    expect(normalizeHashtags('not-an-array', 'hello #world')).toEqual(['world'])
  })
})
