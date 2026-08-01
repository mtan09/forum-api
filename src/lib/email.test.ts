import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendEmail } from './email'

const originalNodeEnv = process.env.NODE_ENV
const originalResendKey = process.env.RESEND_API_KEY
const originalEmailFrom = process.env.EMAIL_FROM

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalResendKey === undefined) delete process.env.RESEND_API_KEY
  else process.env.RESEND_API_KEY = originalResendKey
  if (originalEmailFrom === undefined) delete process.env.EMAIL_FROM
  else process.env.EMAIL_FROM = originalEmailFrom
  vi.restoreAllMocks()
})

describe('sendEmail', () => {
  it('fails closed in production without logging message contents', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.RESEND_API_KEY
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(
      sendEmail({
        to: 'reader@example.com',
        subject: '123456 is your reset code',
        html: '<p>Use 123456 to reset your password.</p>',
      })
    ).rejects.toThrow('Email delivery is not configured')

    expect(log).not.toHaveBeenCalled()
  })

  it('fails closed in production when the verified sender is missing', async () => {
    process.env.NODE_ENV = 'production'
    process.env.RESEND_API_KEY = 're_test_key'
    delete process.env.EMAIL_FROM
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await expect(
      sendEmail({
        to: 'reader@example.com',
        subject: 'Verify your forum email',
        html: '<p>Verify this address.</p>',
      })
    ).rejects.toThrow('Email sender is not configured')

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
