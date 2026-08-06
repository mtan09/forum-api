import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  deletePublicObject: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}))

vi.mock('../db', () => ({ query: mocks.query }))
vi.mock('../lib/r2', () => ({
  publicStorageConfigured: () => true,
  deletePublicObject: mocks.deletePublicObject,
}))
vi.mock('../lib/sentry', () => ({
  captureException: mocks.captureException,
  captureMessage: mocks.captureMessage,
}))

import { processMediaDeletionJobs } from './contentMediaDeletion'

describe('individual content-media deletion jobs', () => {
  beforeEach(() => {
    mocks.query.mockReset()
    mocks.deletePublicObject.mockReset()
    mocks.captureException.mockReset()
    mocks.captureMessage.mockReset()
  })

  it('deletes one exact object and completes the job', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'job-1', object_key: 'owner/123-photo.jpg', attempts: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
    mocks.deletePublicObject.mockResolvedValue(undefined)

    await expect(processMediaDeletionJobs()).resolves.toBe(1)
    expect(String(mocks.query.mock.calls[0][0])).toContain("status = 'processing'")
    expect(String(mocks.query.mock.calls[0][0])).toContain("INTERVAL '15 minutes'")
    expect(mocks.deletePublicObject).toHaveBeenCalledWith('owner/123-photo.jpg')
    expect(String(mocks.query.mock.calls[1][0])).toContain("status = 'complete'")
  })

  it('keeps a failed object deletion retryable', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'job-2', object_key: 'owner/123-photo.jpg', attempts: 2 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
    mocks.deletePublicObject.mockRejectedValue(new Error('R2 timeout'))

    await expect(processMediaDeletionJobs()).resolves.toBe(0)
    expect(String(mocks.query.mock.calls[1][0])).toContain("status = 'failed'")
    expect(mocks.captureException).toHaveBeenCalledOnce()
  })
})
