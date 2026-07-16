import { Hono } from 'hono'
import { query } from '../db'
import type { AppEnv } from '../types'

const articles = new Hono<AppEnv>()

// GET /articles?topic_id=X&subtopic_id=Y — public reference data, newest first
articles.get('/', async (c) => {
  const topicId = c.req.query('topic_id')
  const subtopicId = c.req.query('subtopic_id')
  const limit = Math.min(Number(c.req.query('limit')) || 100, 100)

  const params: unknown[] = []
  const conditions = ["status = 'ready'"]
  if (topicId) {
    params.push(topicId)
    conditions.push(`general_topic_id = $${params.length}`)
  }
  if (subtopicId) {
    params.push(subtopicId)
    conditions.push(`subtopic_id = $${params.length}`)
  }
  params.push(limit)

  const result = await query(
    `SELECT * FROM articles
     WHERE ${conditions.join(' AND ')}
     ORDER BY published_at DESC NULLS LAST
     LIMIT $${params.length}`,
    params
  )
  return c.json(result.rows)
})

// GET /articles/:id
articles.get('/:id', async (c) => {
  const result = await query('SELECT * FROM articles WHERE id = $1', [c.req.param('id')])
  if (!result.rows[0]) return c.json({ error: 'Article not found' }, 404)
  return c.json(result.rows[0])
})

export default articles
