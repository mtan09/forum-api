import { describe, expect, it } from 'vitest'
import {
  articleEngagementOffsetMinutes,
  DemoContentQualityError,
  demoArticleShouldReceiveComment,
  demoArticleVoterCount,
  demoPersonaPostsOnDay,
  demoPerspective,
  demoScoreMatchesPersona,
  demoVoteDirection,
  isExpectedDemoContentQualityFailure,
  scheduledOffsetMinutes,
} from './activity'
import { hasBoilerplateDemoOpening, stripDemoAuthorPrefix } from './generate'
import { scorePost } from '../scoring/score'

describe('demo activity planning', () => {
  it('produces stable, bounded scheduling offsets', () => {
    const first = scheduledOffsetMinutes('2026-08-02:post:john:daily')
    expect(first).toBe(scheduledOffsetMinutes('2026-08-02:post:john:daily'))
    expect(first).toBeGreaterThanOrEqual(5)
    expect(first).toBeLessThanOrEqual(719)
    expect(scheduledOffsetMinutes('2026-08-02:post:jane:daily')).not.toBe(first)
  })

  it('stages a bounded number of article reactions shortly after ingest', () => {
    const offset = articleEngagementOffsetMinutes('article:abc:vote:user')
    expect(offset).toBe(articleEngagementOffsetMinutes('article:abc:vote:user'))
    expect(offset).toBeGreaterThanOrEqual(5)
    expect(offset).toBeLessThanOrEqual(105)
    expect(demoArticleVoterCount('article-a', 31)).toBeGreaterThanOrEqual(2)
    expect(demoArticleVoterCount('article-a', 31)).toBeLessThanOrEqual(5)
    expect(demoArticleVoterCount('article-a', 2)).toBe(2)
    expect(demoArticleVoterCount('article-a', 0)).toBe(0)
  })

  it('comments on a minority of articles and favors clustered coverage', () => {
    const sample = Array.from({ length: 1_000 }, (_, index) => `article-${index}`)
    const clustered = sample.filter((id) => demoArticleShouldReceiveComment(id, true)).length
    const unclustered = sample.filter((id) => demoArticleShouldReceiveComment(id, false)).length
    expect(clustered).toBeGreaterThan(140)
    expect(clustered).toBeLessThan(260)
    expect(unclustered).toBeGreaterThan(40)
    expect(unclustered).toBeLessThan(130)
    expect(clustered).toBeGreaterThan(unclustered)
  })

  it('schedules every persona on two days of each three-day post rotation', () => {
    for (let index = 0; index < 31; index++) {
      const postingDays = [100, 101, 102].filter((day) => demoPersonaPostsOnDay(index, day))
      expect(postingDays).toHaveLength(2)
    }
    const dailyCounts = [100, 101, 102].map((day) =>
      Array.from({ length: 31 }, (_, index) => demoPersonaPostsOnDay(index, day))
        .filter(Boolean).length
    )
    expect(dailyCounts.every((count) => count >= 20 && count <= 21)).toBe(true)
  })

  it('normally supports aligned posts and opposes distant ones', () => {
    const aligned = Array.from({ length: 100 }, (_, index) =>
      demoVoteDirection(0.15, 0.20, `aligned-${index}`)
    )
    const distant = Array.from({ length: 100 }, (_, index) =>
      demoVoteDirection(0.15, 0.90, `distant-${index}`)
    )
    expect(aligned.filter((direction) => direction === 'up').length).toBeGreaterThan(75)
    expect(distant.filter((direction) => direction === 'down').length).toBeGreaterThan(75)
  })

  it('does not force unscored posts into a partisan reaction', () => {
    expect(['up', 'down']).toContain(demoVoteDirection(0.9, null, 'unscored'))
  })

  it('uses persona lean only to validate generated text, not as its score', () => {
    expect(demoPerspective(0.2)).toBe('left')
    expect(demoPerspective(0.5)).toBe('center')
    expect(demoPerspective(0.8)).toBe('right')
    expect(demoScoreMatchesPersona(0.2, 0.31)).toBe(true)
    expect(demoScoreMatchesPersona(0.2, null)).toBe(false)
    expect(demoScoreMatchesPersona(0.8, 0.31)).toBe(false)
    expect(demoScoreMatchesPersona(0.5, null)).toBe(true)
  })

  it('separates an exhausted content-quality retry from an operational failure', () => {
    expect(isExpectedDemoContentQualityFailure(
      new DemoContentQualityError('Generated right demo post remained directionally inconsistent')
    )).toBe(true)
    expect(isExpectedDemoContentQualityFailure(new Error('OpenAI request failed'))).toBe(false)
  })

  it('recognizes mechanical demo-post openings instead of publishing them', () => {
    expect(hasBoilerplateDemoOpening('On a current policy story, I support lower taxes.')).toBe(true)
    expect(hasBoilerplateDemoOpening('As a local organizer, I want a clearer vote.')).toBe(true)
    expect(hasBoilerplateDemoOpening(
      'The committee should publish a cost estimate before advancing the bill.'
    )).toBe(false)
  })

  it('removes duplicated demo authorship only when it is a leading byline', () => {
    expect(stripDemoAuthorPrefix(
      'Nia Brooks (Fictional demo account): The Senate should hold a transparent vote.',
      'Nia Brooks'
    )).toBe('The Senate should hold a transparent vote.')
    expect(stripDemoAuthorPrefix(
      'Nia Brooks — The Senate should hold a transparent vote.',
      'Nia Brooks'
    )).toBe('The Senate should hold a transparent vote.')
    expect(stripDemoAuthorPrefix(
      'I agree with Nia Brooks on the need for a transparent vote.',
      'Nia Brooks'
    )).toBe('I agree with Nia Brooks on the need for a transparent vote.')
    expect(stripDemoAuthorPrefix(
      'Nia Brooks argues that the Senate should hold a transparent vote.',
      'Nia Brooks'
    )).toBe('Nia Brooks argues that the Senate should hold a transparent vote.')
  })
})
