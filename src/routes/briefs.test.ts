import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  verifyToken: vi.fn(() => 'user-1'),
  generateDailyBrief: vi.fn(),
  getDailyBrief: vi.fn(),
  listDailyBriefs: vi.fn(async () => []),
  markDailyBriefSeen: vi.fn(async () => true),
  validTimezone: vi.fn((tz: string) => (tz === 'bad/zone' ? null : tz)),
}))

vi.mock('../db', () => ({ query: mocks.query, default: { query: mocks.query } }))
vi.mock('../lib/daily-brief', () => ({
  generateDailyBrief: mocks.generateDailyBrief,
  getDailyBrief: mocks.getDailyBrief,
  listDailyBriefs: mocks.listDailyBriefs,
  markDailyBriefSeen: mocks.markDailyBriefSeen,
  validTimezone: mocks.validTimezone,
}))
vi.mock('../lib/brief-unsubscribe', () => ({
  verifyDailyBriefUnsubscribeToken: (token: string) =>
    token === 'good' ? 'user-1' : null,
}))
vi.mock('../middleware/auth', () => ({
  requireAuth: async (c: any, next: any) => {
    c.set('userId', 'user-1')
    await next()
  },
}))

import briefs from './briefs'
import legal from './legal'

const app = new Hono()
app.route('/briefs', briefs)
app.route('/legal', legal)

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue({ rows: [], rowCount: 1 })
  mocks.markDailyBriefSeen.mockReset().mockResolvedValue(true)
})

describe('POST /briefs/:id/seen', () => {
  it('rejects a non-uuid id with 404 rather than a database error', async () => {
    // Postgres raises `invalid input syntax for type uuid`, which reached the
    // generic error handler as a 500 and logged a Sentry event — cheap,
    // authenticated, unthrottled quota burn.
    const res = await app.request('/briefs/abc/seen', { method: 'POST' })
    expect(res.status).toBe(404)
    expect(mocks.markDailyBriefSeen).not.toHaveBeenCalled()
  })

  it('accepts a well-formed uuid', async () => {
    const res = await app.request('/briefs/3f8b1a2c-4d5e-4f60-8a71-9b2c3d4e5f60/seen', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(mocks.markDailyBriefSeen).toHaveBeenCalledWith(
      'user-1',
      '3f8b1a2c-4d5e-4f60-8a71-9b2c3d4e5f60'
    )
  })

  it('404s when the brief belongs to someone else', async () => {
    // markDailyBriefSeen scopes its UPDATE by user_id, so a miss is either a
    // bad id or another user's row; both must look identical from outside.
    mocks.markDailyBriefSeen.mockResolvedValue(false)
    const res = await app.request('/briefs/3f8b1a2c-4d5e-4f60-8a71-9b2c3d4e5f60/seen', {
      method: 'POST',
    })
    expect(res.status).toBe(404)
  })
})

describe('GET /briefs/:date', () => {
  it('rejects a malformed date', async () => {
    const res = await app.request('/briefs/not-a-date')
    expect(res.status).toBe(400)
    expect(mocks.getDailyBrief).not.toHaveBeenCalled()
  })
})

describe('unsubscribe', () => {
  it('previews without changing anything on GET', async () => {
    const res = await app.request('/legal/unsubscribe-daily-brief?token=good')
    expect(res.status).toBe(200)
    // A GET must never mutate: mail scanners and link prefetchers follow it.
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('rejects an invalid token on GET', async () => {
    const res = await app.request('/legal/unsubscribe-daily-brief?token=forged')
    expect(res.status).toBe(400)
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('unsubscribes on POST and returns a page for a browser', async () => {
    const res = await app.request('/legal/unsubscribe-daily-brief?token=good', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('email_daily_brief = FALSE'),
      ['user-1']
    )
  })

  it('returns 204 for an RFC 8058 one-click unsubscribe', async () => {
    // The mail client sends `List-Unsubscribe=One-Click` in the request BODY.
    // Reading it from the request headers meant this branch never fired for a
    // real Gmail or Yahoo unsubscribe.
    const res = await app.request('/legal/unsubscribe-daily-brief?token=good', {
      method: 'POST',
      body: 'List-Unsubscribe=One-Click',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(res.status).toBe(204)
  })

  it('records the opt-out even when no prefs row exists yet', async () => {
    const res = await app.request('/legal/unsubscribe-daily-brief?token=good', {
      method: 'POST',
    })
    // Upsert, not update: reporting "invalid link" because a row was missing
    // told a user their unsubscribe failed when it had not.
    expect(res.status).toBe(200)
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT'),
      ['user-1']
    )
  })

  it('rejects a forged token on POST without touching the database', async () => {
    const res = await app.request('/legal/unsubscribe-daily-brief?token=forged', {
      method: 'POST',
    })
    expect(res.status).toBe(400)
    expect(mocks.query).not.toHaveBeenCalled()
  })
})
