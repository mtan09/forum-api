import 'dotenv/config'
import { serve } from '@hono/node-server'
import * as Sentry from '@sentry/node'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import pool from './db'

// Crash reporting: no-op until SENTRY_DSN is set in the environment.
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 })
  console.log('sentry enabled')
}

import type { AppEnv } from './types'
import { rateLimit } from './middleware/rateLimit'
import { runIngest } from './ingest/pipeline'
import adminRoutes from './routes/admin'
import aiRoutes from './routes/ai'
import authRoutes from './routes/auth'
import articlesRoutes from './routes/articles'
import bookmarksRoutes from './routes/bookmarks'
import commentsRoutes from './routes/comments'
import debatesRoutes from './routes/debates'
import legalRoutes from './routes/legal'
import messagesRoutes from './routes/messages'
import postsRoutes from './routes/posts'
import reportsRoutes from './routes/reports'
import searchRoutes from './routes/search'
import shareRoutes from './routes/share'
import sourcesRoutes from './routes/sources'
import storageRoutes from './routes/storage'
import topicsRoutes from './routes/topics'
import usersRoutes from './routes/users'

const app = new Hono<AppEnv>()

app.use('*', logger())
app.use('*', cors())
// Coarse safety net per client IP; the sensitive routes layer stricter,
// user-keyed limits on top of this.
app.use('*', rateLimit({ name: 'global', windowMs: 60_000, max: 300 }))

// Liveness + a real DB round-trip, so uptime monitors catch database
// outages, not just a listening port.
app.get('/health', async (c) => {
  try {
    await pool.query('SELECT 1')
    return c.json({ status: 'ok', db: 'ok', timestamp: new Date().toISOString() })
  } catch (err: any) {
    return c.json({ status: 'degraded', db: 'unreachable', error: err?.message }, 503)
  }
})

// Central error handler: log with stack, report to Sentry when enabled,
// and return a clean 500 instead of leaking internals.
app.onError((err, c) => {
  console.error(`[error] ${c.req.method} ${c.req.path}:`, err)
  if (process.env.SENTRY_DSN) Sentry.captureException(err)
  return c.json({ error: 'Something went wrong on our side.' }, 500)
})

app.route('/auth',     authRoutes)
app.route('/posts',    postsRoutes)
app.route('/articles', articlesRoutes)
app.route('/topics',   topicsRoutes)
app.route('/comments', commentsRoutes)
app.route('/bookmarks', bookmarksRoutes)
app.route('/debates',  debatesRoutes)
app.route('/messages', messagesRoutes)
app.route('/legal',    legalRoutes)
app.route('/',         shareRoutes)
app.route('/reports',  reportsRoutes)
app.route('/search',   searchRoutes)
app.route('/sources',  sourcesRoutes)
app.route('/users',    usersRoutes)
app.route('/storage',  storageRoutes)
app.route('/ai',       aiRoutes)
app.route('/admin',    adminRoutes)

const port = Number(process.env.PORT) || 3000

serve({ fetch: app.fetch, port }, () => {
  console.log(`forum-api running on port ${port}`)
})

// Optional in-process news ingestion. Set INGEST_INTERVAL_MINUTES to
// refresh the article feed on a timer; unset = manual `npm run ingest`.
const ingestMinutes = Number(process.env.INGEST_INTERVAL_MINUTES)
if (Number.isFinite(ingestMinutes) && ingestMinutes > 0) {
  const safeRun = () => runIngest().catch((err: unknown) => console.error('[ingest]', err))
  setTimeout(safeRun, 15_000) // small delay so dev restarts don't hammer feeds
  setInterval(safeRun, ingestMinutes * 60_000)
  console.log(`news ingestion scheduled every ${ingestMinutes} min`)
}
