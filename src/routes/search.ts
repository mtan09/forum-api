import { Hono } from 'hono'
import { query } from '../db'
import { RIGHTS_POLICY_VERSION } from '../ingest/source-rights'
import { publicArticleFields } from '../lib/article-public'
import { searchPhrases, searchTerms } from '../lib/search-query'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

const search = new Hono<AppEnv>()

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SEARCH_LIMIT = 20
const TOPIC_LIMIT = 8

function emptyResponse() {
  return {
    topics: [],
    posts: [],
    articles: [],
    counts: { topics: 0, posts: 0, articles: 0 },
  }
}

// GET /search?q=...
//
// Search has two layers:
// 1. strict web-search matching provides precision and ranks first;
// 2. an OR query across meaningful terms provides recall for broad topics.
//
// Matching story clusters are returned alongside a paged preview of posts and
// articles. Counts always describe the full corpus, not the preview size.
search.get('/', requireAuth, async (c) => {
  const q = String(c.req.query('q') ?? '').trim()
  const topicId = String(c.req.query('topic_id') ?? '').trim()
  if (q.length < 2 && !topicId) return c.json(emptyResponse())

  if (topicId && !UUID_PATTERN.test(topicId)) {
    return c.json({ error: 'Invalid topic ID' }, 400)
  }

  const userId = c.get('userId')
  const terms = searchTerms(q)
  const phrases = searchPhrases(terms)
  const broadQuery = terms.length > 0 ? terms.join(' | ') : q.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const minimumTermMatches = terms.length <= 2 ? 1 : 2
  const tags = terms.map((term) => term.replace(/[^a-z0-9_]/g, '')).filter(Boolean)

  const topicResult = topicId
    ? await query(
        `SELECT s.id, s.title,
                CASE WHEN s.summary_policy_version = $2 THEN s.short_summary ELSE NULL END AS short_summary,
                s.keywords, s.volume,
                s.public_position, s.score,
                count(a.id)::int AS article_count,
                count(DISTINCT a.source)::int AS outlet_count
         FROM subtopics s
         LEFT JOIN articles a ON a.subtopic_id = s.id AND a.status = 'ready'
         WHERE s.id = $1
         GROUP BY s.id`,
        [topicId, RIGHTS_POLICY_VERSION]
      )
    : await query(
        `SELECT s.id, s.title,
                CASE WHEN s.summary_policy_version = $3 THEN s.short_summary ELSE NULL END AS short_summary,
                s.keywords, s.volume,
                s.public_position, s.score,
                count(a.id)::int AS article_count,
                count(DISTINCT a.source)::int AS outlet_count,
                ts_rank(
                  to_tsvector('english', concat_ws(' ', s.title, array_to_string(s.keywords, ' '))),
                  websearch_to_tsquery('english', $1)
                ) AS exact_rank
         FROM subtopics s
         LEFT JOIN articles a ON a.subtopic_id = s.id AND a.status = 'ready'
         WHERE s.cluster_key IS NOT NULL
           AND (
             to_tsvector('english', concat_ws(' ', s.title, array_to_string(s.keywords, ' ')))
               @@ websearch_to_tsquery('english', $1)
             OR EXISTS (
               SELECT 1
               FROM unnest($4::text[]) AS phrase
               WHERE phrase = ANY(s.keywords)
                  OR position(phrase IN lower(coalesce(s.title, ''))) > 0
             )
           )
         GROUP BY s.id
         HAVING count(a.id) > 0
         ORDER BY exact_rank DESC, s.score DESC, s.updated_at DESC
         LIMIT $2`,
        [q, TOPIC_LIMIT, RIGHTS_POLICY_VERSION, phrases]
      )

  const topicIds = topicResult.rows.map((topic) => topic.id)
  const postMatch = `
    NOT p.hidden
    AND (
      p.search_tsv @@ websearch_to_tsquery('english', $2)
      OR (
        SELECT count(*)
        FROM unnest($4::text[]) AS term
        WHERE p.search_tsv @@ plainto_tsquery('english', term)
           OR term = ANY(p.hashtags)
      ) >= $5
    )
    AND NOT EXISTS(
      SELECT 1 FROM blocks bl
      WHERE bl.blocker_id = $1 AND bl.blocked_id = p.user_id
    )`
  const postCountMatch = `
    NOT p.hidden
    AND (
      p.search_tsv @@ websearch_to_tsquery('english', $2)
      OR (
        SELECT count(*)
        FROM unnest($3::text[]) AS term
        WHERE p.search_tsv @@ plainto_tsquery('english', term)
           OR term = ANY(p.hashtags)
      ) >= $4
    )
    AND NOT EXISTS(
      SELECT 1 FROM blocks bl
      WHERE bl.blocker_id = $1 AND bl.blocked_id = p.user_id
    )`
  const articleMatch = topicId
    ? `a.status = 'ready' AND a.subtopic_id = $3`
    : `a.status = 'ready'
       AND (
         a.search_tsv @@ websearch_to_tsquery('english', $2)
         OR a.subtopic_id = ANY($3::uuid[])
         OR EXISTS (
           SELECT 1
           FROM unnest($4::text[]) AS phrase
           WHERE phrase = ANY(a.event_terms)
              OR position(phrase IN lower(coalesce(a.title, ''))) > 0
         )
       )`
  const articleCountMatch = topicId
    ? `a.status = 'ready' AND a.subtopic_id = $1`
    : `a.status = 'ready'
       AND (
         a.search_tsv @@ websearch_to_tsquery('english', $1)
         OR a.subtopic_id = ANY($2::uuid[])
         OR EXISTS (
           SELECT 1
           FROM unnest($3::text[]) AS phrase
           WHERE phrase = ANY(a.event_terms)
              OR position(phrase IN lower(coalesce(a.title, ''))) > 0
         )
       )`
  const postParams = [userId, q, broadQuery, tags, minimumTermMatches]
  const postCountParams = [userId, q, tags, minimumTermMatches]
  const articleParams = [userId, q, topicId || topicIds, phrases]
  const articleCountParams = topicId ? [topicId] : [q, topicIds, phrases]

  const [posts, postCount, articles, articleCount] = await Promise.all([
    query(
      `SELECT p.id, p.user_id, p.content, p.media_url, p.general_topic_id, p.position,
              p.hashtags, p.upvotes, p.downvotes, p.commentcount, p.created_at,
              u.username, u.avatar_url,
              v.direction AS my_vote,
              EXISTS(
                SELECT 1 FROM bookmarks b
                WHERE b.post_id = p.id AND b.user_id = $1
              ) AS my_bookmark
       FROM posts p
       JOIN userdata u ON u.id = p.user_id
       LEFT JOIN votes v ON v.post_id = p.id AND v.user_id = $1
       WHERE ${postMatch}
       ORDER BY
         (p.search_tsv @@ websearch_to_tsquery('english', $2)) DESC,
         ts_rank(p.search_tsv, websearch_to_tsquery('english', $2)) DESC,
         ts_rank(p.search_tsv, to_tsquery('english', $3)) DESC,
         p.created_at DESC
       LIMIT ${SEARCH_LIMIT}`,
      postParams
    ),
    query(
      `SELECT count(*)::int AS count
       FROM posts p
       WHERE ${postCountMatch}`,
      postCountParams
    ),
    query(
      `SELECT ${publicArticleFields('a')},
              v.direction AS my_vote,
              EXISTS(
                SELECT 1 FROM bookmarks b
                WHERE b.article_id = a.id AND b.user_id = $1
              ) AS my_bookmark
       FROM articles a
       LEFT JOIN article_votes v ON v.article_id = a.id AND v.user_id = $1
       WHERE ${articleMatch}
       ORDER BY
         (a.search_tsv @@ websearch_to_tsquery('english', $2)) DESC,
         (EXISTS (
           SELECT 1
           FROM unnest($4::text[]) AS phrase
           WHERE phrase = ANY(a.event_terms)
              OR position(phrase IN lower(coalesce(a.title, ''))) > 0
         )) DESC,
         ts_rank(a.search_tsv, websearch_to_tsquery('english', $2)) DESC,
         a.published_at DESC NULLS LAST
       LIMIT ${SEARCH_LIMIT}`,
      articleParams
    ),
    query(
      `SELECT count(*)::int AS count
       FROM articles a
       WHERE ${articleCountMatch}`,
      articleCountParams
    ),
  ])

  return c.json({
    topics: topicResult.rows,
    posts: posts.rows,
    articles: articles.rows,
    counts: {
      topics: topicResult.rows.length,
      posts: postCount.rows[0]?.count ?? 0,
      articles: articleCount.rows[0]?.count ?? 0,
    },
  })
})

export default search
