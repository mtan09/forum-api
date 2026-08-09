import { describe, expect, it } from 'vitest'
import { briefIsReady, dailyBriefDateKey, localClock, validTimezone } from './daily-brief'
import { dailyBriefEmail } from './daily-brief-delivery'
import { dailyBriefUnsubscribeToken, verifyDailyBriefUnsubscribeToken } from './brief-unsubscribe'

describe('Daily Brief clock', () => {
  it('uses the user timezone rather than the server timezone', () => {
    const now = new Date('2026-08-08T10:59:00.000Z')
    expect(localClock(now, 'America/New_York')).toEqual({ date: '2026-08-08', minutes: 419 })
    expect(briefIsReady(now, 'America/New_York')).toBe(false)
    expect(briefIsReady(new Date('2026-08-08T11:00:00.000Z'), 'America/New_York')).toBe(true)
  })

  it('follows daylight saving time through IANA rules', () => {
    expect(localClock(new Date('2026-01-08T12:00:00.000Z'), 'America/New_York').minutes).toBe(420)
    expect(localClock(new Date('2026-08-08T11:00:00.000Z'), 'America/New_York').minutes).toBe(420)
  })

  it('rejects invalid and oversized timezone names', () => {
    expect(validTimezone('America/Los_Angeles')).toBe('America/Los_Angeles')
    expect(validTimezone('Not/A_Real_Zone')).toBeNull()
    expect(validTimezone('x'.repeat(81))).toBeNull()
  })

  it('serializes database dates as stable route keys', () => {
    expect(dailyBriefDateKey('2026-08-08')).toBe('2026-08-08')
    expect(dailyBriefDateKey('2026-08-08T00:00:00.000Z')).toBe('2026-08-08')
    expect(dailyBriefDateKey(new Date('2026-08-08T00:00:00.000Z'))).toBe('2026-08-08')
    expect(dailyBriefDateKey('Sat Aug 08 2026 00:00:00 GMT+0000')).toBe('2026-08-08')
  })
})

describe('Daily Brief unsubscribe token', () => {
  it('round-trips a signed user id and rejects tampering', () => {
    process.env.JWT_SECRET = 'daily-brief-test-secret'
    const token = dailyBriefUnsubscribeToken('user-1')
    expect(verifyDailyBriefUnsubscribeToken(token)).toBe('user-1')
    expect(verifyDailyBriefUnsubscribeToken(`${token}x`)).toBeNull()
  })

  // Tampering the signature only proves the HMAC is checked at all. The case
  // that matters is swapping the SUBJECT: if a body could be edited and
  // replayed, anyone holding their own link could unsubscribe another account.
  it('rejects a token whose subject has been swapped for another user', () => {
    process.env.JWT_SECRET = 'daily-brief-test-secret'
    const mine = dailyBriefUnsubscribeToken('user-1')
    const [body, signature] = mine.split('.')
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    expect(decoded.sub).toBe('user-1')

    const forged = Buffer.from(JSON.stringify({ ...decoded, sub: 'victim-2' })).toString('base64url')
    expect(verifyDailyBriefUnsubscribeToken(`${forged}.${signature}`)).toBeNull()
    expect(verifyDailyBriefUnsubscribeToken(forged)).toBeNull()
  })

  it('rejects a correctly-signed token issued for another purpose', () => {
    process.env.JWT_SECRET = 'daily-brief-test-secret'
    const { createHmac } = require('node:crypto') as typeof import('node:crypto')
    const body = Buffer.from(JSON.stringify({
      sub: 'user-1', purpose: 'password-reset', v: 1, iat: Math.floor(Date.now() / 1000),
    })).toString('base64url')
    const signature = createHmac('sha256', 'daily-brief-test-secret').update(body).digest('base64url')
    expect(verifyDailyBriefUnsubscribeToken(`${body}.${signature}`)).toBeNull()
  })

  it('rejects a correctly-signed token past its maximum age', () => {
    process.env.JWT_SECRET = 'daily-brief-test-secret'
    const { createHmac } = require('node:crypto') as typeof import('node:crypto')
    const body = Buffer.from(JSON.stringify({
      sub: 'user-1', purpose: 'daily-brief-email', v: 1,
      iat: Math.floor(Date.now() / 1000) - 400 * 86400,
    })).toString('base64url')
    const signature = createHmac('sha256', 'daily-brief-test-secret').update(body).digest('base64url')
    expect(verifyDailyBriefUnsubscribeToken(`${body}.${signature}`)).toBeNull()
  })

  it('prefers a dedicated secret so session rotation cannot invalidate links', () => {
    process.env.JWT_SECRET = 'session-secret'
    process.env.BRIEF_UNSUBSCRIBE_SECRET = 'unsubscribe-secret'
    const token = dailyBriefUnsubscribeToken('user-1')
    // Rotating the session secret must leave links in already-sent email valid.
    process.env.JWT_SECRET = 'rotated-session-secret'
    expect(verifyDailyBriefUnsubscribeToken(token)).toBe('user-1')
    delete process.env.BRIEF_UNSUBSCRIBE_SECRET
  })

  it('survives malformed input without throwing', () => {
    process.env.JWT_SECRET = 'daily-brief-test-secret'
    for (const bad of ['', '.', 'a.b', 'not base64!!.sig', '...']) {
      expect(() => verifyDailyBriefUnsubscribeToken(bad)).not.toThrow()
      expect(verifyDailyBriefUnsubscribeToken(bad)).toBeNull()
    }
  })
})

describe('Daily Brief email', () => {
  it('uses canonical links, escapes content, and omits zero activity', () => {
    const message = dailyBriefEmail({
      id: 'brief-1',
      brief_date: '2026-08-08',
      timezone: 'America/New_York',
      window_start: '2026-08-07T11:00:00.000Z',
      window_end: '2026-08-08T11:00:00.000Z',
      generated_at: '2026-08-08T11:00:01.000Z',
      seen_at: null,
      stories: [{ id: 'story-1', title: 'Budget <deal>', outlet_count: 3, article_count: 5 }],
      posts: [{ id: 'post-1', username: 'Alex', content: 'A & B' }],
      floor: [{ id: 'floor-1', title: 'Should Congress act?' }],
      floor_recap: [],
      activity: {
        replies: 1, comments: 0, post_upvotes: 0, comment_upvotes: 0,
        reposts: 0, quotes: 0, followers: 0, follow_requests: 0, unread_dms: 0,
      },
    }, 'https://forumeveryside.com', 'https://api.forumeveryside.com/legal/unsubscribe-daily-brief?token=test')

    expect(message.html).toContain('https://forumeveryside.com/brief/2026-08-08')
    expect(message.html).toContain('https://forumeveryside.com/summary/story-1')
    expect(message.html).toContain('Budget &lt;deal&gt;')
    expect(message.html).toContain('A &amp; B')
    expect(message.html).toContain('1 reply')
    expect(message.html).not.toContain('0 comments')
    expect(message.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })
})
