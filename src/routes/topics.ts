import { Hono } from 'hono'
import { query } from '../db'
import type { AppEnv } from '../types'

const topics = new Hono<AppEnv>()

// GET /topics — returns all topics with their subtopics nested
// No auth required: topics are public reference data
topics.get('/', async (c) => {
  const [topicsResult, subtopicsResult] = await Promise.all([
    query('SELECT * FROM general_topics ORDER BY importance DESC'),
    query('SELECT * FROM subtopics ORDER BY general_topic_id, title'),
  ])

  const result = topicsResult.rows.map((topic) => ({
    ...topic,
    subtopics: subtopicsResult.rows.filter(
      (s) => s.general_topic_id === topic.id
    ),
  }))

  return c.json(result)
})

// GET /topics/subtopics/:id — subtopic detail plus its articles
topics.get('/subtopics/:id', async (c) => {
  const id = c.req.param('id')
  const [subtopicResult, articlesResult] = await Promise.all([
    query('SELECT * FROM subtopics WHERE id = $1', [id]),
    query(
      `SELECT * FROM articles WHERE subtopic_id = $1 AND status = 'ready'
       ORDER BY published_at DESC NULLS LAST`,
      [id]
    ),
  ])
  if (!subtopicResult.rows[0]) return c.json({ error: 'Subtopic not found' }, 404)
  return c.json({ ...subtopicResult.rows[0], articles: articlesResult.rows })
})

export default topics
