import { describe, expect, it, vi } from 'vitest'
import { isDatabaseConnectionError, withRetry } from './pipeline'

describe('ingest reliability', () => {
  it('recognizes database wake-up and connection failures', () => {
    expect(isDatabaseConnectionError(new Error('Connection terminated due to connection timeout'))).toBe(true)
    expect(isDatabaseConnectionError({ code: '57P03', message: 'starting up' })).toBe(true)
    expect(isDatabaseConnectionError({
      code: '25P03',
      message: 'terminating connection due to idle-in-transaction timeout',
    })).toBe(true)
    expect(isDatabaseConnectionError(new Error('RSS returned HTTP 404'))).toBe(false)
  })

  it('retries a transient operation and returns the successful value', async () => {
    vi.useFakeTimers()
    let calls = 0
    const promise = withRetry(
      'test',
      async () => {
        calls++
        if (calls < 3) throw new Error('temporary')
        return 42
      },
      () => true
    )
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toBe(42)
    expect(calls).toBe(3)
    vi.useRealTimers()
  })

  it('does not retry a permanent failure', async () => {
    let calls = 0
    await expect(
      withRetry(
        'test',
        async () => {
          calls++
          throw new Error('permanent')
        },
        () => false
      )
    ).rejects.toThrow('permanent')
    expect(calls).toBe(1)
  })
})
