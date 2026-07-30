import { describe, expect, it } from 'vitest'
import { leadOf, type ArticleRow } from './cluster'

const article = (title = 'A concise article headline'): ArticleRow => ({
  id: 'article-1',
  title,
  description: null,
  source: 'Example News',
  source_lean: 0.5,
  political_lean: 0.5,
  general_topic_id: null,
  published_at: '2026-07-21T12:00:00.000Z',
  created_at: '2026-07-21T12:00:00.000Z',
  media: null,
  image_mode: 'none',
  entities: ['Congress'],
  event_terms: ['war powers'],
})

describe('leadOf', () => {
  it('never exceeds the requested length', () => {
    const lead = leadOf(article('A very long headline ' + 'without a useful stopping point '.repeat(30)), 260)

    expect(lead.length).toBeLessThanOrEqual(260)
    expect(lead.endsWith('…')).toBe(true)
  })

  it('uses the attributed headline rather than article prose', () => {
    const headline = 'Congress approves war-powers measure after late vote'
    expect(leadOf(article(headline))).toBe(headline)
  })
})
