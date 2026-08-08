import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FOLLOW_REQUESTS_PATH,
  commentPath,
  dmPath,
  postPath,
  userPath,
} from './notification-routes'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  sendEmail: vi.fn(),
  notificationEmail: vi.fn(() => ({ subject: 'subject', html: 'html' })),
}))

vi.mock('../db', () => ({ query: mocks.query }))
vi.mock('./sentry', () => ({
  captureException: mocks.captureException,
  captureMessage: mocks.captureMessage,
}))
vi.mock('./email', () => ({
  notificationEmail: mocks.notificationEmail,
  sendEmail: mocks.sendEmail,
}))

import { deliver } from './push'
import type { NotificationKind } from './push'

type Prefs = {
  push_enabled?: boolean
  push_kind_enabled?: boolean
  email_enabled?: boolean
  email_kind_enabled?: boolean
  email?: string | null
  email_verified?: boolean
}

const prefsRow = (overrides: Prefs = {}) => ({
  push_enabled: true,
  push_kind_enabled: true,
  email_enabled: false,
  email_kind_enabled: false,
  email: 'reader@example.com',
  email_verified: true,
  ...overrides,
})

/** Queues the prefs lookup, then the token lookup, then a permissive default. */
function stubDb(prefs: Prefs = {}, tokens = ['ExponentPushToken[test]']) {
  mocks.query.mockReset()
  mocks.query
    .mockResolvedValueOnce({ rows: [prefsRow(prefs)] })
    .mockResolvedValueOnce({ rows: tokens.map((token) => ({ token })) })
    .mockResolvedValue({ rows: [], rowCount: 1 })
}

function stubExpo() {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ data: [{ status: 'ok', id: 'ticket-1' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The message array POSTed to Expo, or null if no push was attempted. */
function sentMessages(fetchMock: ReturnType<typeof stubExpo>) {
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/push/send'))
  if (!call) return null
  return JSON.parse(String(call[1]?.body))
}

// One row per notification the API can emit, with the destination each one
// should carry. If a screen is renamed and its builder updated, this table is
// the thing that has to change with it.
const CASES: { name: string; kind: NotificationKind; url: string }[] = [
  { name: 'reply to your comment on a post', kind: 'replies', url: commentPath({ postId: 'p1' }) },
  { name: 'reply on an article', kind: 'replies', url: commentPath({ articleId: 'a1' }) },
  { name: 'reply in a debate', kind: 'replies', url: commentPath({ debateId: 'd1' }) },
  { name: 'comment on your post', kind: 'replies', url: postPath('p1') },
  { name: 'new direct message', kind: 'dms', url: dmPath('sender-1') },
  { name: 'post upvoted', kind: 'upvotes', url: postPath('p1') },
  { name: 'follow request accepted', kind: 'follows', url: userPath('u1') },
  { name: 'new follower', kind: 'follows', url: userPath('u1') },
  { name: 'new follow request', kind: 'follows', url: FOLLOW_REQUESTS_PATH },
]

describe('notification delivery', () => {
  beforeEach(() => {
    mocks.captureException.mockReset()
    mocks.captureMessage.mockReset()
    mocks.sendEmail.mockReset()
    mocks.notificationEmail.mockClear()
    vi.stubEnv('WEB_APP_URL', 'https://forumeveryside.com')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  describe('push payload', () => {
    it.each(CASES)('$name carries $url', async ({ kind, url }) => {
      stubDb()
      const fetchMock = stubExpo()

      await deliver('user-1', kind, { title: 't', body: 'b', data: { url } })

      const messages = sentMessages(fetchMock)
      expect(messages).toHaveLength(1)
      expect(messages[0].data.url).toBe(url)
      expect(messages[0].to).toBe('ExponentPushToken[test]')
    })

    // Every destination has to be an in-app path. The client drops anything
    // that does not start with '/', which is how the Floor reminder silently
    // stopped routing.
    it.each(CASES)('$name is a rootward in-app path', ({ url }) => {
      expect(url.startsWith('/')).toBe(true)
      expect(url).not.toContain('undefined')
      expect(url).not.toContain('//')
    })
  })

  describe('preference gating', () => {
    it('sends nothing when push is disabled outright', async () => {
      stubDb({ push_enabled: false })
      const fetchMock = stubExpo()

      await deliver('user-1', 'replies', { title: 't', body: 'b' })

      expect(sentMessages(fetchMock)).toBeNull()
    })

    it('sends nothing when only that kind is disabled', async () => {
      stubDb({ push_kind_enabled: false })
      const fetchMock = stubExpo()

      await deliver('user-1', 'dms', { title: 't', body: 'b' })

      expect(sentMessages(fetchMock)).toBeNull()
    })

    it('still emails when push is off but email is on', async () => {
      stubDb({ push_enabled: false, email_enabled: true, email_kind_enabled: true })
      const fetchMock = stubExpo()

      await deliver('user-1', 'replies', {
        title: 't',
        body: 'b',
        data: { url: postPath('p1') },
      })

      expect(sentMessages(fetchMock)).toBeNull()
      expect(mocks.sendEmail).toHaveBeenCalledOnce()
    })

    it('does not email an unverified address', async () => {
      stubDb({ email_enabled: true, email_kind_enabled: true, email_verified: false })
      stubExpo()

      await deliver('user-1', 'replies', { title: 't', body: 'b' })

      expect(mocks.sendEmail).not.toHaveBeenCalled()
    })

    it('does not email when the kind is off', async () => {
      stubDb({ email_enabled: true, email_kind_enabled: false })
      stubExpo()

      await deliver('user-1', 'follows', { title: 't', body: 'b' })

      expect(mocks.sendEmail).not.toHaveBeenCalled()
    })
  })

  describe('email link', () => {
    it('points at the web app with the same path as the push', async () => {
      stubDb({ email_enabled: true, email_kind_enabled: true })
      stubExpo()

      await deliver('user-1', 'dms', {
        title: 't',
        body: 'b',
        data: { url: dmPath('sender-1') },
      })

      expect(mocks.notificationEmail).toHaveBeenCalledWith(
        't',
        'b',
        'https://forumeveryside.com/dm/sender-1'
      )
    })

    it('omits the link rather than guessing when WEB_APP_URL is unset', async () => {
      vi.stubEnv('WEB_APP_URL', '')
      stubDb({ email_enabled: true, email_kind_enabled: true })
      stubExpo()

      await deliver('user-1', 'replies', {
        title: 't',
        body: 'b',
        data: { url: postPath('p1') },
      })

      expect(mocks.notificationEmail).toHaveBeenCalledWith('t', 'b', undefined)
    })
  })

  // Upvotes are the one kind that must not email per event — they accumulate
  // into a digest row instead.
  describe('upvote digest', () => {
    it('queues a digest row instead of sending immediately', async () => {
      stubDb({ email_enabled: true, email_kind_enabled: true })
      stubExpo()

      await deliver('user-1', 'upvotes', {
        title: 't',
        body: 'b',
        data: { url: postPath('p1'), post_id: 'p1' },
      })

      expect(mocks.sendEmail).not.toHaveBeenCalled()
      const digestInsert = mocks.query.mock.calls.find(([sql]) =>
        String(sql).includes('notification_email_digests')
      )
      expect(digestInsert?.[1]).toEqual(['user-1', 'p1'])
    })
  })
})
