import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import pool from './db'
import { redactRequestLog } from './lib/request-log'
import { captureException, initSentry } from './lib/sentry'
import { processDeletionJobs } from './jobs/deletion'
import { processMediaDeletionJobs } from './jobs/contentMediaDeletion'
import { flushEmailDigests, processPushReceipts } from './lib/push'

initSentry()

import type { AppEnv } from './types'
import { rateLimit } from './middleware/rateLimit'
import adminRoutes from './routes/admin'
import aiRoutes from './routes/ai'
import authRoutes from './routes/auth'
import articlesRoutes from './routes/articles'
import bookmarksRoutes from './routes/bookmarks'
import commentsRoutes from './routes/comments'
import debatesRoutes from './routes/debates'
import feedbackRoutes from './routes/feedback'
import feedRoutes from './routes/feed'
import legalRoutes from './routes/legal'
import messagesRoutes from './routes/messages'
import postsRoutes from './routes/posts'
import reportsRoutes from './routes/reports'
import repostsRoutes from './routes/reposts'
import searchRoutes from './routes/search'
import shareRoutes from './routes/share'
import sourcesRoutes from './routes/sources'
import storageRoutes from './routes/storage'
import topicsRoutes from './routes/topics'
import usersRoutes from './routes/users'

const app = new Hono<AppEnv>()

app.use('*', logger((message, ...rest) => console.log(redactRequestLog(message), ...rest)))
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
  captureException(err, { method: c.req.method, path: c.req.path })
  return c.json({ error: 'Something went wrong on our side.' }, 500)
})

app.route('/auth',     authRoutes)
app.route('/posts',    postsRoutes)
app.route('/articles', articlesRoutes)
app.route('/topics',   topicsRoutes)
app.route('/comments', commentsRoutes)
app.route('/bookmarks', bookmarksRoutes)
app.route('/debates',  debatesRoutes)
app.route('/feedback', feedbackRoutes)
app.route('/feed',     feedRoutes)
app.route('/messages', messagesRoutes)
app.route('/legal',    legalRoutes)
app.route('/',         shareRoutes)
app.route('/reports',  reportsRoutes)
app.route('/reposts',  repostsRoutes)
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

// Small durable-job pump for email coalescing, push delivery receipts, and
// account-media cleanup.
// News ingestion intentionally does not run here; Railway owns that schedule.
const runBackgroundJobs = () =>
  Promise.all([
    processDeletionJobs(),
    processMediaDeletionJobs(),
    flushEmailDigests(),
    processPushReceipts(),
  ]).catch((err) => {
    console.error('[jobs] background run failed:', err)
    captureException(err, { component: 'background-jobs' })
  })
const initialJobsTimer = setTimeout(runBackgroundJobs, 10_000)
const jobsTimer = setInterval(runBackgroundJobs, 5 * 60_000)
initialJobsTimer.unref()
jobsTimer.unref()
