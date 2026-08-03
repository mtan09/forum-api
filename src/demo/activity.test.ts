import { describe, expect, it } from 'vitest'
import { demoVoteDirection, scheduledOffsetMinutes } from './activity'

describe('demo activity planning', () => {
  it('produces stable, bounded scheduling offsets', () => {
    const first = scheduledOffsetMinutes('2026-08-02:post:john:daily')
    expect(first).toBe(scheduledOffsetMinutes('2026-08-02:post:john:daily'))
    expect(first).toBeGreaterThanOrEqual(5)
    expect(first).toBeLessThanOrEqual(719)
    expect(scheduledOffsetMinutes('2026-08-02:post:jane:daily')).not.toBe(first)
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
})
