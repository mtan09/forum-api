import { describe, expect, it } from 'vitest'
import { resolveSentryRelease } from './sentry'

describe('resolveSentryRelease', () => {
  it('prefers an explicitly configured Sentry release', () => {
    expect(
      resolveSentryRelease({
        SENTRY_RELEASE: 'forum-api@1fab54c',
        RAILWAY_GIT_COMMIT_SHA: 'git-sha',
        RAILWAY_DEPLOYMENT_ID: 'deployment-id',
      })
    ).toBe('forum-api@1fab54c')
  })

  it('uses the Git commit for GitHub-triggered Railway deployments', () => {
    expect(resolveSentryRelease({ RAILWAY_GIT_COMMIT_SHA: 'git-sha' })).toBe('git-sha')
  })

  it('uses Railway deployment identity for CLI deployments', () => {
    expect(resolveSentryRelease({ RAILWAY_DEPLOYMENT_ID: 'deployment-id' })).toBe(
      'railway:deployment-id'
    )
  })

  it('still gives local events a stable non-empty release', () => {
    expect(resolveSentryRelease({})).toBe('forum-api@unknown')
  })
})
