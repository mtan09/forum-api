import { Hono } from 'hono'
import { query } from '../db'
import type { AppEnv } from '../types'

const topics = new Hono<AppEnv>()

// GET /topics — returns all topics with their subtopics nested
// No auth required: topics are public reference data
topics.get('/', async (c) => {
  const [topicsResult, subtopicsResult] = await Promise.all([
    query('SELECT * FROM general_topics ORDER BY importance DESC'),
    query(
      `SELECT * FROM subtopics s
       WHERE s.cluster_key IS NULL
          OR (
            s.score > 0
            AND EXISTS (
              SELECT 1 FROM articles a
              WHERE a.subtopic_id = s.id AND a.status = 'ready'
            )
          )
       ORDER BY general_topic_id, title`
    ),
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
  const requestedId = c.req.param('id')
  const subtopicResult = await query('SELECT * FROM subtopics WHERE id = $1', [requestedId])
  if (!subtopicResult.rows[0]) return c.json({ error: 'Subtopic not found' }, 404)

  let subtopic = subtopicResult.rows[0]
  let resolvedFromId: string | null = null
  const loadArticles = (id: string) =>
    query(
      `SELECT id, url, title, source, media, political_lean,
         political_relevance, lean_confidence, content_type, lean_signals,
         source_lean, scorer_version, upvotes, downvotes, commentcount,
         general_topic_id, subtopic_id, published_at, status, created_at,
         ai_context_allowed FROM articles WHERE subtopic_id = $1 AND status = 'ready'
       ORDER BY published_at DESC NULLS LAST`,
      [id]
    )

  let articlesResult = await loadArticles(requestedId)
  if (articlesResult.rows.length === 0 && subtopic.cluster_key) {
    const keywords = Array.isArray(subtopic.keywords) ? subtopic.keywords : []
    const replacement = await query(
      `SELECT s.*,
              (SELECT count(*)::int
               FROM unnest(COALESCE(s.keywords, '{}'::text[])) keyword
               WHERE keyword = ANY($2::text[])) AS keyword_overlap
       FROM subtopics s
       WHERE s.id <> $1
         AND s.cluster_key IS NOT NULL
         AND s.score > 0
         AND EXISTS (
           SELECT 1 FROM articles a
           WHERE a.subtopic_id = s.id AND a.status = 'ready'
         )
         AND (
           lower(s.title) = lower($3)
           OR (
             SELECT count(*)
             FROM unnest(COALESCE(s.keywords, '{}'::text[])) keyword
             WHERE keyword = ANY($2::text[])
           ) >= 2
         )
       ORDER BY (lower(s.title) = lower($3)) DESC,
                keyword_overlap DESC,
                s.score DESC
       LIMIT 1`,
      [requestedId, keywords, subtopic.title]
    )
    if (replacement.rows[0]) {
      resolvedFromId = requestedId
      subtopic = replacement.rows[0]
      articlesResult = await loadArticles(subtopic.id)
    }
  }

  if (articlesResult.rows.length === 0) {
    return c.json({ error: 'This story is no longer active.' }, 410)
  }
  return c.json({
    ...subtopic,
    resolved_from_id: resolvedFromId,
    articles: articlesResult.rows,
  })
})

export default topics
