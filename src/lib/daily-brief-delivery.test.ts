import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  sendEmail: vi.fn(),
  sendPushToUser: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}))

vi.mock('../db', () => ({ query: mocks.query }))
vi.mock('./email', () => ({ sendEmail: mocks.sendEmail }))
// Token minting reads the signing secret from the environment and throws when
// it is absent, which would otherwise be swallowed by the send path's catch
// and look like a delivery failure.
vi.mock('./brief-unsubscribe', () => ({
  dailyBriefUnsubscribeToken: () => 'token',
}))
vi.mock('./push', () => ({ sendPushToUser: mocks.sendPushToUser }))
vi.mock('./sentry', () => ({
  captureException: mocks.captureException,
  captureMessage: mocks.captureMessage,
}))

import { deliverBrief } from './daily-brief-delivery'
import type { DailyBrief } from './daily-brief'

type Prefs = {
  push_enabled?: boolean
  email_enabled?: boolean
  push_daily_brief?: boolean
  email_daily_brief?: boolean
  email?: string | null
  email_verified?: boolean
}

const brief = {
  id: 'b1',
  brief_date: '2026-08-08',
  stories: [{ id: 's1', title: 'Story' }],
  posts: [],
  floor: [],
  activity: { replies: 1, comments: 0, post_upvotes: 0, comment_upvotes: 0, reposts: 0, quotes: 0, followers: 0, follow_requests: 0, unread_dms: 0 },
} as unknown as DailyBrief

/** Routes on SQL text rather than call order, so the assertions survive an
 *  extra query being added anywhere in the path. */
function stubDb(prefs: Prefs = {}, claims: { email?: number; push?: number } = {}) {
  mocks.query.mockReset()
  const statements: string[] = []
  mocks.query.mockImplementation(async (sql: string) => {
    statements.push(sql)
    if (sql.includes('FROM notification_prefs p JOIN auth_credentials')) {
      return {
        rows: [{
          push_enabled: true,
          email_enabled: true,
          push_daily_brief: true,
          email_daily_brief: true,
          email: 'reader@example.com',
          email_verified: true,
          emailed_at: null,
          pushed_at: null,
          ...prefs,
        }],
      }
    }
    if (sql.includes('SET emailed_at = NOW()')) {
      return { rows: [], rowCount: claims.email ?? 1 }
    }
    if (sql.includes('SET pushed_at = NOW()')) {
      return { rows: [], rowCount: claims.push ?? 1 }
    }
    return { rows: [], rowCount: 1 }
  })
  return statements
}

const ran = (statements: string[], fragment: string) =>
  statements.some((s) => s.includes(fragment))

beforeEach(() => {
  mocks.sendEmail.mockReset().mockResolvedValue(undefined)
  mocks.sendPushToUser.mockReset().mockResolvedValue(1)
  mocks.captureException.mockReset()
})

describe('deliverBrief — dedupe', () => {
  it('claims the email before sending, conditioned on emailed_at being unset', async () => {
    const statements = stubDb()
    await deliverBrief('u1', brief)
    // The guard is the WHERE clause. Reading emailed_at and writing it after
    // the await is the race that lets an overlapping run send twice.
    expect(ran(statements, 'SET emailed_at = NOW()')).toBe(true)
    expect(statements.find((s) => s.includes('SET emailed_at = NOW()')))
      .toContain('emailed_at IS NULL')
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1)
  })

  it('does not send when another worker already holds the claim', async () => {
    stubDb({}, { email: 0, push: 0 })
    await deliverBrief('u1', brief)
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(mocks.sendPushToUser).not.toHaveBeenCalled()
  })

  it('releases the email claim when sending throws, so it can retry', async () => {
    const statements = stubDb()
    mocks.sendEmail.mockRejectedValue(new Error('resend 500'))
    await deliverBrief('u1', brief)
    expect(ran(statements, 'SET emailed_at = NULL')).toBe(true)
    expect(mocks.captureException).toHaveBeenCalled()
  })
})

describe('deliverBrief — push delivery is verified, not assumed', () => {
  it('keeps pushed_at when Expo accepted at least one message', async () => {
    const statements = stubDb()
    mocks.sendPushToUser.mockResolvedValue(2)
    await deliverBrief('u1', brief)
    expect(ran(statements, 'SET pushed_at = NULL')).toBe(false)
  })

  it('releases pushed_at when nothing was accepted', async () => {
    // sendPushToUser never throws: no tokens, a 502 from Expo and a rejected
    // ticket all return normally. Marking the brief pushed on a zero count
    // means the due query stops selecting it and the user silently gets
    // nothing for that edition.
    const statements = stubDb()
    mocks.sendPushToUser.mockResolvedValue(0)
    await deliverBrief('u1', brief)
    expect(ran(statements, 'SET pushed_at = NULL')).toBe(true)
  })

  it('releases pushed_at when the push path throws', async () => {
    const statements = stubDb()
    mocks.sendPushToUser.mockRejectedValue(new Error('network'))
    await deliverBrief('u1', brief)
    expect(ran(statements, 'SET pushed_at = NULL')).toBe(true)
    expect(mocks.captureException).toHaveBeenCalled()
  })
})

describe('deliverBrief — gating matrix', () => {
  it.each([
    ['email disabled globally', { email_enabled: false }],
    ['brief email opted out', { email_daily_brief: false }],
    ['address unverified', { email_verified: false }],
    ['no address on file', { email: null }],
  ])('sends no email when %s', async (_label, prefs) => {
    stubDb(prefs)
    await deliverBrief('u1', brief)
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it.each([
    ['push disabled globally', { push_enabled: false }],
    ['brief push opted out', { push_daily_brief: false }],
  ])('sends no push when %s', async (_label, prefs) => {
    stubDb(prefs)
    await deliverBrief('u1', brief)
    expect(mocks.sendPushToUser).not.toHaveBeenCalled()
  })

  it('does nothing at all when the user has no prefs row', async () => {
    mocks.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 })
    await deliverBrief('u1', brief)
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(mocks.sendPushToUser).not.toHaveBeenCalled()
  })

  it('delivers on both channels independently', async () => {
    stubDb()
    await deliverBrief('u1', brief)
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1)
    expect(mocks.sendPushToUser).toHaveBeenCalledTimes(1)
    expect(mocks.sendPushToUser).toHaveBeenCalledWith(
      'u1',
      'daily_brief',
      expect.objectContaining({ data: { url: '/brief/2026-08-08' } })
    )
  })
})
