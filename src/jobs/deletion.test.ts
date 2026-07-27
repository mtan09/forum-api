import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  deletePrefix: vi.fn(),
}))

vi.mock('../db', () => ({ query: mocks.query }))
vi.mock('../lib/r2', () => ({
  publicStorageConfigured: () => true,
  feedbackStorageConfigured: () => true,
  deletePrefix: mocks.deletePrefix,
}))

import { processDeletionJobs } from './deletion'

describe('account media deletion jobs', () => {
  beforeEach(() => {
    mocks.query.mockReset()
    mocks.deletePrefix.mockReset()
    process.env.R2_BUCKET_NAME = 'public'
    process.env.R2_FEEDBACK_BUCKET_NAME = 'feedback'
  })

  it('marks a job complete after both private and public prefixes are removed', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'job-1',
            public_prefix: 'user-1/',
            feedback_prefix: 'feedback/user-1/',
            attempts: 1,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
    mocks.deletePrefix.mockResolvedValue(2)
    await expect(processDeletionJobs()).resolves.toBe(1)
    expect(mocks.deletePrefix).toHaveBeenNthCalledWith(1, 'public', 'user-1/')
    expect(mocks.deletePrefix).toHaveBeenNthCalledWith(
      2,
      'feedback',
      'feedback/user-1/'
    )
    expect(String(mocks.query.mock.calls[1][0])).toContain("status = 'complete'")
  })

  it('keeps a failed job retryable with backoff', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'job-2',
            public_prefix: 'user-2/',
            feedback_prefix: 'feedback/user-2/',
            attempts: 2,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
    mocks.deletePrefix.mockRejectedValueOnce(new Error('R2 timeout'))
    await expect(processDeletionJobs()).resolves.toBe(0)
    expect(String(mocks.query.mock.calls[1][0])).toContain("status = 'failed'")
    expect(mocks.query.mock.calls[1][1][2]).toBe('R2 timeout')
  })
})
