import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import type { AppEnv } from './types'
import aiRoutes from './routes/ai'
import authRoutes from './routes/auth'
import articlesRoutes from './routes/articles'
import commentsRoutes from './routes/comments'
import postsRoutes from './routes/posts'
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
app.route('/users',    usersRoutes)
app.route('/storage',  storageRoutes)
app.route('/ai',       aiRoutes)

const port = Number(process.env.PORT) || 3000

serve({ fetch: app.fetch, port }, () => {
  console.log(`forum-api running on port ${port}`)
})
