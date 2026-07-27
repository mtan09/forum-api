import * as Sentry from '@sentry/node'

let initialized = false

export function initSentry() {
  if (initialized || !process.env.SENTRY_DSN) return
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE ?? process.env.RAILWAY_GIT_COMMIT_SHA,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers.authorization
        delete event.request.headers.Authorization
        delete event.request.headers.cookie
        delete event.request.headers.Cookie
      }
      if (event.user) {
        delete event.user.email
        delete event.user.ip_address
        delete event.user.username
      }
      return event
    },
  })
  initialized = true
  console.log('sentry enabled')
}

export function captureException(error: unknown, context?: Record<string, unknown>) {
  if (!process.env.SENTRY_DSN) return
  Sentry.captureException(error, context ? { extra: context } : undefined)
}

export function captureMessage(
  message: string,
  level: 'info' | 'warning' | 'error' = 'warning',
  context?: Record<string, unknown>
) {
  if (!process.env.SENTRY_DSN) return
  Sentry.captureMessage(message, {
    level,
    extra: context,
  })
}
