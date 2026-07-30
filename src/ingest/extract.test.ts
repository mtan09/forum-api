import { describe, expect, it } from 'vitest'
import { extractArticleText, normalizeArticleImageUrl, selectArticleImageUrl } from './extract'
import { rightsForSource } from './source-rights'

const ARTICLE = 'https://thehill.com/policy/defense/5982033-hegseth-caine-iran-funding/'
const FEED_IMAGE =
  'https://thehill.com/wp-content/uploads/sites/2/2026/07/hegseth_pete_071726gn02_w.jpg?w=900'

describe('article image selection', () => {
  it('validates the canonical feed enclosure', () => {
    expect(selectArticleImageUrl(ARTICLE, FEED_IMAGE)).toBe(FEED_IMAGE)
  })

  it('rejects an article URL with an encoded photo caption appended', () => {
    const malformed = `${ARTICLE}Defense%20Secretary%20Pete%20Hegseth%20testifies`
    expect(normalizeArticleImageUrl(malformed, ARTICLE)).toBeNull()
  })

  it('keeps same-origin and extensionless CDN images used by other outlets', () => {
    const article = 'https://news.example.com/politics/a-story/'

    expect(normalizeArticleImageUrl('/uploads/story-image.jpeg?w=900', article)).toBe(
      'https://news.example.com/uploads/story-image.jpeg?w=900'
    )
    expect(normalizeArticleImageUrl('https://image-cdn.example/opaque-asset-id', article)).toBe(
      'https://image-cdn.example/opaque-asset-id'
    )
  })

  it('rejects non-http image schemes', () => {
    expect(normalizeArticleImageUrl('data:image/png;base64,abc', ARTICLE)).toBeNull()
  })

  it('does not ingest feed body or image when policy is metadata-only', async () => {
    const extracted = await extractArticleText({
      title: 'A political headline',
      url: ARTICLE,
      summary: 'A publisher-written summary that is not licensed for reuse.',
      contentHtml: '<p>The complete feed article body.</p>',
      publishedAt: new Date('2026-07-29T12:00:00Z'),
      categories: ['Politics'],
      imageUrl: FEED_IMAGE,
    }, rightsForSource('the-hill'))

    expect(extracted.analysisText).toBe('')
    expect(extracted.publicDescription).toBeNull()
    expect(extracted.imageUrl).toBeNull()
    expect(extracted.usedFullPage).toBe(false)
  })
})
