import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import type { AppEnv } from './types'
import { runIngest } from './ingest/pipeline'
import aiRoutes from './routes/ai'
import authRoutes from './routes/auth'
import articlesRoutes from './routes/articles'
import bookmarksRoutes from './routes/bookmarks'
import commentsRoutes from './routes/comments'
import debatesRoutes from './routes/debates'
import postsRoutes from './routes/posts'
import reportsRoutes from './routes/reports'
import searchRoutes from './routes/search'
import sourcesRoutes from './routes/sources'
import storageRoutes from './routes/storage'
import topicsRoutes from './routes/topics'
import usersRoutes from './routes/users'

const app = new Hono<AppEnv>()

app.use('*', logger())
app.use('*', cors())

app.get('/health', (c) =>
  c.json({ status: 'ok', timestamp: new Date().toISOString() })
)

app.route('/auth',     authRoutes)
app.route('/posts',    postsRoutes)
app.route('/articles', articlesRoutes)
app.route('/topics',   topicsRoutes)
app.route('/comments', commentsRoutes)
app.route('/bookmarks', bookmarksRoutes)
app.route('/debates',  debatesRoutes)
app.route('/reports',  reportsRoutes)
app.route('/search',   searchRoutes)
app.route('/sources',  sourcesRoutes)
app.route('/users',    usersRoutes)
app.route('/storage',  storageRoutes)
app.route('/ai',       aiRoutes)

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
