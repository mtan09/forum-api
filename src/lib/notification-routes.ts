// In-app paths a notification can point at. These are consumed two ways: as
// `data.url` on the push payload, which the client feeds to expo-router, and
// as the path half of the email link (WEB_APP_URL + path). Both platforms run
// the same router, so one list serves both.
//
// They live here rather than inline at the notify() call sites so the set of
// reachable destinations is enumerable — `notification-routes.test.ts` asserts
// each one still matches a screen in the client repo.

export const postPath = (postId: string) => `/post/${postId}`
export const articlePath = (articleId: string) => `/article/${articleId}`
export const debatePath = (debateId: string) => `/debate/${debateId}`
export const userPath = (userId: string) => `/user/${userId}`

/** The conversation with `senderId` — the recipient opens the sender's thread. */
export const dmPath = (senderId: string) => `/dm/${senderId}`

export const FOLLOW_REQUESTS_PATH = '/follow-requests'
export const briefPath = (briefDate: string) => `/brief/${briefDate}`

/**
 * Where a comment notification points. Replies inherit their parent's target,
 * so exactly one of these is set by the time a notification is built.
 */
export function commentPath(target: {
  postId?: string | null
  articleId?: string | null
  debateId?: string | null
}): string {
  if (target.postId) return postPath(target.postId)
  if (target.articleId) return articlePath(target.articleId)
  if (target.debateId) return debatePath(target.debateId)
  // POST /comments rejects a body with no target, so this is unreachable via
  // the API. Falling back to the Floor beats emitting `/debate/undefined`.
  return '/debate'
}
