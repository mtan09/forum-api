import { describe, expect, it } from 'vitest'
import { normalizeArticleImageUrl, selectArticleImageUrl } from './extract'

const ARTICLE = 'https://thehill.com/policy/defense/5982033-hegseth-caine-iran-funding/'
const FEED_IMAGE =
  'https://thehill.com/wp-content/uploads/sites/2/2026/07/hegseth_pete_071726gn02_w.jpg?w=900'

describe('article image selection', () => {
  it('prefers the canonical feed enclosure over page metadata', () => {
    expect(selectArticleImageUrl(ARTICLE, FEED_IMAGE, 'https://cdn.example.com/other.jpg')).toBe(
      FEED_IMAGE
    )
  })

  it('rejects an article URL with an encoded photo caption appended', () => {
    const malformed = `${ARTICLE}Defense%20Secretary%20Pete%20Hegseth%20testifies`
    expect(normalizeArticleImageUrl(malformed, ARTICLE)).toBeNull()
  })

  it('falls back to a valid page image when a feed has no image', () => {
    const pageImage = '/wp-content/uploads/photo.webp?width=1200'
    expect(selectArticleImageUrl(ARTICLE, null, pageImage)).toBe(
      'https://thehill.com/wp-content/uploads/photo.webp?width=1200'
    )
  })

  it('falls back when any outlet supplies malformed feed metadata', () => {
    const article = 'https://news.example.com/politics/a-story/'
    const malformedFeedImage = `${article}Photo%20caption%20instead%20of%20an%20image`
    const pageImage = 'https://images.cdn.example/assets/abc123'

    expect(selectArticleImageUrl(article, malformedFeedImage, pageImage)).toBe(pageImage)
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
})
