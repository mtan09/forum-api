import { describe, expect, it } from 'vitest'
import { leadOf, type ArticleRow } from './cluster'

const article = (content: string, title = 'A concise article headline'): ArticleRow => ({
  id: 'article-1',
  title,
  content,
  source: 'Example News',
  source_lean: 0.5,
  political_lean: 0.5,
  general_topic_id: null,
  published_at: '2026-07-21T12:00:00.000Z',
  created_at: '2026-07-21T12:00:00.000Z',
  media: null,
})

describe('leadOf', () => {
  it('never exceeds the requested length for any source', () => {
    const lead = leadOf(article('A very long sentence ' + 'without a useful stopping point '.repeat(30)), 260)

    expect(lead.length).toBeLessThanOrEqual(260)
    expect(lead.endsWith('…')).toBe(true)
  })

  it('rejects video-player navigation text and uses the headline', () => {
    const chrome =
      'July 21, 2026 02:09 Now Playing 03:22 Video headline UP NEXT 00:21 Another video ' +
      'More unrelated player navigation '.repeat(30)

    expect(leadOf(article(chrome))).toBe('A concise article headline')
  })

  it('keeps normal article prose intact', () => {
    const content =
      'Congress approved the measure after a late vote on Tuesday. The bill now moves to the president for consideration.'

    expect(leadOf(article(content))).toBe(content)
  })
})
