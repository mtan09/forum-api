import { describe, expect, it } from 'vitest'
import {
  deterministicCategories,
  moderateImage,
  moderateText,
  moderationFailure,
} from './moderation'

describe('deterministic moderation', () => {
  it('hard-stops direct threats before calling the provider', async () => {
    let called = false
    const result = await moderateText(null, 'post', 'I am going to kill you tonight.', {
      audit: false,
      provider: async () => {
        called = true
        return { flagged: false, categories: [] }
      },
    })
    expect(called).toBe(false)
    expect(result.decision).toBe('reject')
    expect(result.categories).toContain('threat')
  })

  it('does not mistake ordinary political language for a direct threat', () => {
    expect(
      deterministicCategories('Congress should kill this bill before the final vote.')
    ).toEqual([])
  })

  it('passes clean text through the provider', async () => {
    const result = await moderateText(null, 'comment', 'I disagree with this policy.', {
      audit: false,
      provider: async () => ({ flagged: false, categories: [], model: 'test-model' }),
    })
    expect(result).toMatchObject({ decision: 'allow', provider: 'openai', model: 'test-model' })
  })

  it('returns a distinct retryable outage response', async () => {
    const result = await moderateText(null, 'dm', 'Hello', {
      audit: false,
      provider: async () => {
        throw new Error('offline')
      },
    })
    expect(moderationFailure(result)).toMatchObject({
      status: 503,
      body: { code: 'MODERATION_UNAVAILABLE', retryable: true },
    })
  })

  it('sends image data URLs to the provider', async () => {
    let received: unknown
    const result = await moderateImage('user', Buffer.from('image'), 'image/jpeg', {
      audit: false,
      consentGranted: true,
      provider: async (input) => {
        received = input
        return { flagged: true, categories: ['violence/graphic'] }
      },
    })
    expect(JSON.stringify(received)).toContain('data:image/jpeg;base64,')
    expect(result.decision).toBe('reject')
  })

  it('does not call OpenAI when an authenticated user has not consented', async () => {
    let called = false
    const result = await moderateText('user', 'post', 'A normal political opinion.', {
      audit: false,
      consentGranted: false,
      provider: async () => {
        called = true
        return { flagged: false, categories: [] }
      },
    })
    expect(called).toBe(false)
    expect(moderationFailure(result)).toMatchObject({
      status: 428,
      body: { code: 'AI_CONSENT_REQUIRED' },
    })
  })

  it('can apply on-server rules without a provider during declined signup', async () => {
    let called = false
    const result = await moderateText(null, 'username', 'civil_username', {
      audit: false,
      useProvider: false,
      provider: async () => {
        called = true
        return { flagged: false, categories: [] }
      },
    })
    expect(called).toBe(false)
    expect(result).toMatchObject({ decision: 'allow', provider: 'rules' })
  })
})
