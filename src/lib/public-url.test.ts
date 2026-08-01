import { afterEach, describe, expect, it } from 'vitest'
import { publicApiOrigin } from './public-url'

const originalPublicApiUrl = process.env.PUBLIC_API_URL

afterEach(() => {
  if (originalPublicApiUrl === undefined) delete process.env.PUBLIC_API_URL
  else process.env.PUBLIC_API_URL = originalPublicApiUrl
})

describe('publicApiOrigin', () => {
  it('prefers the configured public origin behind a TLS-terminating proxy', () => {
    process.env.PUBLIC_API_URL = 'https://api.forumeveryside.com/path-is-ignored'

    expect(publicApiOrigin(new Request('http://forum-api.railway.internal/auth/signup')))
      .toBe('https://api.forumeveryside.com')
  })

  it('uses trusted forwarded origin fields when no origin is configured', () => {
    delete process.env.PUBLIC_API_URL
    const request = new Request('http://forum-api.railway.internal/auth/signup', {
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'api.forumeveryside.com',
      },
    })

    expect(publicApiOrigin(request)).toBe('https://api.forumeveryside.com')
  })

  it('falls back to the request origin for local development', () => {
    delete process.env.PUBLIC_API_URL

    expect(publicApiOrigin(new Request('http://localhost:3000/auth/signup')))
      .toBe('http://localhost:3000')
  })
})
