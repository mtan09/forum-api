import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  sendEmail: vi.fn(),
}))

vi.mock('../db', () => ({ query: mocks.query }))
vi.mock('./sentry', () => ({
  captureException: mocks.captureException,
  captureMessage: mocks.captureMessage,
}))
vi.mock('./email', () => ({
  notificationEmail: vi.fn(),
  sendEmail: mocks.sendEmail,
}))

import { deliver, processPushReceipts } from './push'

describe('Expo push delivery receipts', () => {
  beforeEach(() => {
    mocks.query.mockReset()
    mocks.captureException.mockReset()
    mocks.captureMessage.mockReset()
    mocks.sendEmail.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('persists successful ticket ids for later receipt checks', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{
          push_enabled: true,
          push_kind_enabled: true,
          email_enabled: false,
          email_kind_enabled: false,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ token: 'ExponentPushToken[test]' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ status: 'ok', id: 'ticket-1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ))

    await deliver('user-1', 'replies', { title: 'Reply', body: 'Someone replied.' })

    expect(mocks.query.mock.calls[2][0]).toContain('INSERT INTO push_receipts')
    expect(mocks.query.mock.calls[2][1]).toEqual([
      'ticket-1',
      'ExponentPushToken[test]',
      'user-1',
      'replies',
    ])
  })

  it('removes a confirmed receipt after Expo reports delivery', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ ticket_id: 'ticket-1', token: 'token-1', kind: 'replies' }],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ data: { 'ticket-1': { status: 'ok' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ))

    const result = await processPushReceipts()

    expect(result).toMatchObject({ checked: 1, delivered: 1, failed: 0 })
    expect(mocks.query.mock.calls[2][0]).toContain('DELETE FROM push_receipts')
  })

  it('prunes an invalid device token from a terminal receipt error', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ ticket_id: 'ticket-2', token: 'dead-token', kind: 'dms' }],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        data: {
          'ticket-2': {
            status: 'error',
            details: { error: 'DeviceNotRegistered' },
          },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ))

    const result = await processPushReceipts()

    expect(result).toMatchObject({ checked: 1, failed: 1, tokensPruned: 1 })
    expect(mocks.query.mock.calls[2][0]).toContain('DELETE FROM push_tokens')
    expect(mocks.captureMessage).toHaveBeenCalledWith(
      'Expo push receipt failed',
      'warning',
      expect.objectContaining({ error: 'DeviceNotRegistered', kind: 'dms' })
    )
  })

  it('retries when a receipt is not ready yet', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ ticket_id: 'ticket-3', token: 'token-3', kind: 'follows' }],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ))

    const result = await processPushReceipts()

    expect(result).toMatchObject({ checked: 1, pending: 1 })
    expect(mocks.query.mock.calls[2][0]).toContain("last_error = 'receipt_not_ready'")
  })
})
