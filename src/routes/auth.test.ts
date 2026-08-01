import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppEnv } from '../types'

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn()
  return {
    clientQuery,
    connect: vi.fn(async () => ({
      query: clientQuery,
      release: vi.fn(),
    })),
    poolQuery: vi.fn(),
    moderateText: vi.fn(async () => ({
      decision: 'allow',
      provider: 'rules',
      categories: [],
    })),
    issueToken: vi.fn(async () => 'jwt'),
    hashPassword: vi.fn(async () => 'hash'),
    verifyPassword: vi.fn(async () => true),
    resetEmail: vi.fn((code: string) => ({
      subject: `${code} reset`,
      html: `Reset with ${code}`,
    })),
    sendEmail: vi.fn(async () => {}),
  }
})

vi.mock('../db', () => ({
  default: {
    connect: mocks.connect,
    query: mocks.poolQuery,
  },
}))
vi.mock('../lib/auth', () => ({
  hashPassword: mocks.hashPassword,
  issueToken: mocks.issueToken,
  verifyPassword: mocks.verifyPassword,
}))
vi.mock('../lib/email', () => ({
  resetEmail: mocks.resetEmail,
  sendEmail: mocks.sendEmail,
  verificationEmail: vi.fn(() => ({ subject: 'Verify', html: 'body' })),
}))
vi.mock('../lib/moderation', () => ({
  moderateText: mocks.moderateText,
  moderationFailure: () => null,
}))

import auth from './auth'

const app = new Hono<AppEnv>().route('/auth', auth)

describe('signup OpenAI permission', () => {
  beforeEach(() => {
    mocks.clientQuery.mockReset()
    mocks.connect.mockClear()
    mocks.poolQuery.mockReset()
    mocks.moderateText.mockClear()
    mocks.issueToken.mockClear()
    mocks.hashPassword.mockClear()
    mocks.resetEmail.mockClear()
    mocks.sendEmail.mockClear()
  })

  it('requires an explicit allow or decline decision', async () => {
    const response = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'reader',
        email: 'reader@example.com',
        password: 'secret1',
      }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'AI_CONSENT_DECISION_REQUIRED',
    })
    expect(mocks.moderateText).not.toHaveBeenCalled()
  })

  it('creates a declined account without calling the OpenAI provider', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ id: 'user-1', username: 'reader', created_at: new Date().toISOString() }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    const response = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'reader',
        email: 'reader@example.com',
        password: 'secret1',
        ai_consent_accepted: false,
        ai_consent_version: '2026-07-30',
      }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      user: {
        ai_consent_status: 'declined',
        ai_consent_current: false,
      },
    })
    expect(mocks.moderateText).toHaveBeenCalledWith(
      null,
      'username',
      'reader',
      { useProvider: false }
    )
    expect(mocks.clientQuery.mock.calls[3][0]).toContain('INSERT INTO ai_data_consents')
    const generatedUserId = mocks.clientQuery.mock.calls[1][1][0]
    expect(mocks.clientQuery.mock.calls[3][1]).toEqual([
      generatedUserId,
      '2026-07-30',
      'declined',
    ])
  })
})

describe('password recovery', () => {
  beforeEach(() => {
    mocks.poolQuery.mockReset()
    mocks.hashPassword.mockClear()
    mocks.resetEmail.mockClear()
    mocks.sendEmail.mockClear()
  })

  it('does not reveal whether an email address has an account', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] })

    const response = await app.request('/auth/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'missing@example.com' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('replaces the prior reset code and emails a new one', async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await app.request('/auth/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'Reader@Example.com' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(mocks.poolQuery.mock.calls[1][0]).toContain('DELETE FROM email_tokens')
    expect(mocks.poolQuery.mock.calls[2][0]).toContain('INSERT INTO email_tokens')
    const code = mocks.poolQuery.mock.calls[2][1][0]
    expect(code).toMatch(/^\d{6}$/)
    expect(mocks.sendEmail).toHaveBeenCalledWith({
      to: 'reader@example.com',
      subject: `${code} reset`,
      html: `Reset with ${code}`,
    })
  })

  it('rejects an incorrect code before changing the password', async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [{ token: '123456' }] })

    const response = await app.request('/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'reader@example.com',
        code: '654321',
        new_password: 'new-secret',
      }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid or expired code.',
    })
    expect(mocks.hashPassword).not.toHaveBeenCalled()
  })

  it('changes the password, verifies the email, and consumes a valid code', async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [{ token: '123456' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await app.request('/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'reader@example.com',
        code: '123456',
        new_password: 'new-secret',
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(mocks.hashPassword).toHaveBeenCalledWith('new-secret')
    expect(mocks.poolQuery.mock.calls[2]).toEqual([
      expect.stringContaining('email_verified = TRUE'),
      ['hash', 'user-1'],
    ])
    expect(mocks.poolQuery.mock.calls[3]).toEqual([
      expect.stringContaining('DELETE FROM email_tokens'),
      ['user-1'],
    ])
  })
})

describe('email verification', () => {
  beforeEach(() => {
    mocks.poolQuery.mockReset()
  })

  it('atomically consumes a live link and verifies the account', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] })

    const response = await app.request('/auth/verify?token=verification-token')

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Email verified')
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1)
    expect(mocks.poolQuery.mock.calls[0][0]).toContain('WITH claimed AS')
    expect(mocks.poolQuery.mock.calls[0][0]).toContain('SET email_verified = TRUE')
    expect(mocks.poolQuery.mock.calls[0][1]).toEqual(['verification-token'])
  })

  it('shows a safe expired-link page without changing an account', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] })

    const response = await app.request('/auth/verify?token=expired-token')

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Link expired')
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1)
  })
})

describe('login verification state', () => {
  beforeEach(() => {
    mocks.poolQuery.mockReset()
    mocks.issueToken.mockClear()
    mocks.verifyPassword.mockClear()
  })

  it('returns email verification state immediately after login', async () => {
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [{
        id: 'user-1',
        username: 'reader',
        email: 'reader@example.com',
        email_verified: false,
        password_hash: 'stored-hash',
        is_banned: false,
        ai_consent_status: 'declined',
        ai_consent_current: false,
        ai_consent_version: '2026-07-30',
      }],
    })

    const response = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'reader@example.com',
        password: 'secret1',
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      user: {
        id: 'user-1',
        email: 'reader@example.com',
        email_verified: false,
      },
    })
    expect(mocks.poolQuery.mock.calls[0][0]).toContain('a.email_verified')
    expect(mocks.verifyPassword).toHaveBeenCalledWith('secret1', 'stored-hash')
  })
})
