import 'dotenv/config'
import pool from '../src/db'
import { clusterAndPublish } from '../src/ingest/cluster'
import { extractArticleText } from '../src/ingest/extract'
import { extractKeywords, toHashtags } from '../src/ingest/keywords'
import { SOURCES } from '../src/ingest/sources'
import { matchTopic } from '../src/ingest/topics'
import { scoreArticle } from '../src/scoring/score'

const APPLY = process.env.APPLY_ARTICLE_CONTENT_BACKFILL === 'true'
const LIMIT = Math.max(1, Number(process.env.ARTICLE_CONTENT_BACKFILL_LIMIT ?? 300))
const DAYS = Math.max(1, Number(process.env.ARTICLE_CONTENT_BACKFILL_DAYS ?? 7))
const sourceByName = new Map(SOURCES.map((source) => [source.name, source]))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  // Restore stories users are actively seeing first, followed by the newest
  // stripped articles. The job is bounded, repeatable, and dry-run by default.
  const candidates = await pool.query(
    `SELECT a.id, a.url, a.title, a.source, a.description, a.media_source_url,
            a.published_at, a.created_at,
            CASE WHEN s.score > 0 THEN 0 ELSE 1 END AS priority
     FROM articles a
     LEFT JOIN subtopics s ON s.id = a.subtopic_id
     WHERE a.status = 'ready'
       AND (a.content IS NULL OR a.content = '' OR a.media IS NULL)
       AND COALESCE(a.published_at, a.created_at) > NOW() - ($2 * INTERVAL '1 day')
     ORDER BY priority, COALESCE(a.published_at, a.created_at) DESC
     LIMIT $1`,
    [LIMIT, DAYS]
  )

  if (!APPLY) {
    console.log(JSON.stringify({
      apply: false,
      candidates: candidates.rowCount ?? 0,
      limit: LIMIT,
      days: DAYS,
      note: 'Set APPLY_ARTICLE_CONTENT_BACKFILL=true to restore this batch.',
    }, null, 2))
    return
  }

  let restoredContent = 0
  let restoredImages = 0
  let failed = 0

  for (const row of candidates.rows) {
    try {
      const source = sourceByName.get(String(row.source))
      const extracted = await extractArticleText({
        title: String(row.title ?? ''),
        url: String(row.url),
        summary: String(row.description ?? ''),
        contentHtml: '',
        publishedAt: row.published_at ? new Date(row.published_at) : null,
        categories: [],
        imageUrl: row.media_source_url ? String(row.media_source_url) : null,
      })
      const text = extracted.text.trim()
      const media = extracted.imageUrl
      const score = scoreArticle({
        title: String(row.title ?? ''),
        content: text,
        url: String(row.url),
        sourcePrior: source?.lean,
        categories: [],
      })
      const topic = await matchTopic(`${row.title} ${text}`)
      const hashtags = toHashtags(extractKeywords(String(row.title ?? ''), text).top)

      await pool.query(
        `UPDATE articles
         SET content = CASE WHEN $2 = '' THEN content ELSE $2 END,
             media = COALESCE($3, media),
             political_lean = $4,
             political_relevance = $5,
             lean_confidence = $6,
             content_type = $7,
             lean_signals = $8,
             source_lean = COALESCE($9, source_lean),
             scorer_version = $10,
             general_topic_id = COALESCE($11, general_topic_id),
             hashtags = $12
         WHERE id = $1`,
        [
          row.id,
          text,
          media,
          score.political_lean,
          score.political_relevance,
          score.lean_confidence,
          score.content_type,
          score.lean_signals,
          source?.lean ?? null,
          score.scorer_version,
          topic.generalTopicId,
          hashtags,
        ]
      )
      if (text) restoredContent++
      if (media) restoredImages++
    } catch (error) {
      failed++
      console.warn(`[article-backfill] failed ${row.id}: ${(error as Error).message}`)
    }
    await sleep(150)
  }

  await clusterAndPublish()
  console.log(JSON.stringify({
    candidates: candidates.rowCount ?? 0,
    restoredContent,
    restoredImages,
    failed,
  }, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
