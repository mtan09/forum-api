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

// GET /topics/hot — auto-clustered hot topics for the feed carousel,
// hottest first (score = corroborated articles × outlet spread + posts)
topics.get('/hot', async (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 8, 20)
  const result = await query(
    `SELECT s.id, s.title, s.short_summary, s.keywords, s.volume,
            s.public_position, s.score,
            (SELECT count(*)::int
             FROM articles a
             WHERE a.subtopic_id = s.id AND a.status = 'ready') AS article_count
     FROM subtopics s
     WHERE s.cluster_key IS NOT NULL AND s.score > 0
       AND s.updated_at > NOW() - INTERVAL '7 days'
     ORDER BY s.score DESC, s.updated_at DESC
     LIMIT $1`,
    [limit]
  )
  return c.json(result.rows)
})

// GET /topics/subtopics/:id — subtopic detail plus its articles
topics.get('/subtopics/:id', async (c) => {
  const id = c.req.param('id')
  const [subtopicResult, articlesResult] = await Promise.all([
    query('SELECT * FROM subtopics WHERE id = $1', [id]),
    query(
      `SELECT id, url, title, source, content, media, political_lean,
         political_relevance, lean_confidence, content_type, lean_signals,
         source_lean, scorer_version, upvotes, downvotes, commentcount,
         general_topic_id, subtopic_id, published_at, status, created_at FROM articles WHERE subtopic_id = $1 AND status = 'ready'
       ORDER BY published_at DESC NULLS LAST`,
      [id]
    ),
  ])
  if (!subtopicResult.rows[0]) return c.json({ error: 'Subtopic not found' }, 404)
  return c.json({ ...subtopicResult.rows[0], articles: articlesResult.rows })
})

export default topics
