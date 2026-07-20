// Ingestion pipeline: RSS feeds → dedupe → extract text → relevance
// gate → deterministic scoring → insert as 'ready'. Idempotent — the
// articles.url and articles.content_hash UNIQUE constraints make
// re-runs no-ops for already-seen items.

import { createHash } from 'node:crypto'
import { query } from '../db'
import { scoreArticle } from '../scoring/score'
import { clusterAndPublish } from './cluster'
import { extractArticleText } from './extract'
import { extractKeywords, toHashtags } from './keywords'
import { fetchFeed } from './rss'
import { SOURCES, type Source } from './sources'
import { matchTopic } from './topics'

// Override for one-off backfills: INGEST_MAX_ITEMS=50 npm run ingest
const MAX_ITEMS_PER_FEED = Number(process.env.INGEST_MAX_ITEMS) || 10
const MIN_RELEVANCE = 0.25

export type IngestStats = {
  feedsOk: number
  feedsFailed: number
  seen: number
  inserted: number
  skippedDuplicate: number
  skippedIrrelevant: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function ingestSource(source: Source, stats: IngestStats) {
  for (const feedUrl of source.feeds) {
    let items
    try {
      items = await fetchFeed(feedUrl)
      stats.feedsOk++
    } catch (err) {
      stats.feedsFailed++
      console.warn(`[ingest] feed failed: ${(err as Error).message}`)
      continue
    }

    for (const item of items.slice(0, MAX_ITEMS_PER_FEED)) {
      stats.seen++
      if (!item.title) continue

      // Cheap dedupe before doing any page fetching
      const contentHash = createHash('sha256')
        .update(`${source.name}::${item.title.toLowerCase()}`)
        .digest('hex')
      const dup = await query(
        'SELECT 1 FROM articles WHERE url = $1 OR content_hash = $2 LIMIT 1',
        [item.url, contentHash]
      )
      if (dup.rows.length > 0) {
        stats.skippedDuplicate++
        continue
      }

      const extracted = await extractArticleText(item)
      const score = scoreArticle({
        title: item.title,
        content: extracted.text,
        url: item.url,
        sourcePrior: source.lean,
        categories: item.categories,
      })

      if (score.political_relevance < MIN_RELEVANCE) {
        stats.skippedIrrelevant++
        continue
      }

      const topic = await matchTopic(`${item.title} ${extracted.text}`)
      // Auto-hashtags from the article's own keywords; subtopic_id is
      // assigned afterwards by the clustering pass, not here
      const hashtags = toHashtags(extractKeywords(item.title, extracted.text).top)

      await query(
        `INSERT INTO articles
           (url, content_hash, title, source, content, media,
            political_lean, political_relevance, lean_confidence,
            content_type, lean_signals, source_lean, scorer_version,
            general_topic_id, hashtags, published_at, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'ready')
         ON CONFLICT DO NOTHING`,
        [
          item.url, contentHash, item.title, source.name,
          extracted.text, extracted.imageUrl,
          score.political_lean, score.political_relevance, score.lean_confidence,
          score.content_type, score.lean_signals, source.lean, score.scorer_version,
          topic.generalTopicId, hashtags, extracted.publishedAt,
        ]
      )
      stats.inserted++
      await sleep(250) // stay polite to article pages
    }
  }
}

export async function runIngest(): Promise<IngestStats> {
  const stats: IngestStats = {
    feedsOk: 0, feedsFailed: 0, seen: 0,
    inserted: 0, skippedDuplicate: 0, skippedIrrelevant: 0,
  }
  const started = Date.now()
  console.log(`[ingest] starting run across ${SOURCES.length} sources`)

  for (const source of SOURCES) {
    try {
      await ingestSource(source, stats)
    } catch (err) {
      console.warn(`[ingest] source ${source.name} failed: ${(err as Error).message}`)
    }
  }

  console.log(
    `[ingest] done in ${Math.round((Date.now() - started) / 1000)}s — ` +
    `${stats.inserted} inserted, ${stats.skippedDuplicate} duplicate, ` +
    `${stats.skippedIrrelevant} irrelevant, ${stats.feedsFailed} feed(s) failed`
  )

  // Re-cluster whenever fresh articles arrived so hot topics stay current
  if (stats.inserted > 0) {
    try {
      await clusterAndPublish()
    } catch (err) {
      console.warn(`[cluster] failed: ${(err as Error).message}`)
    }
  }
  return stats
}
