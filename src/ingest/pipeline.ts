// Ingestion pipeline: RSS feeds → dedupe → rights-aware metadata → relevance
// gate → deterministic scoring → insert as 'ready'. Idempotent — the
// articles.url and articles.content_hash UNIQUE constraints make
// re-runs no-ops for already-seen items.

import { createHash } from 'node:crypto'
import pool, { query } from '../db'
import { captureException, captureMessage } from '../lib/sentry'
import { scoreArticle } from '../scoring/score'
import { buildArticleMetadata } from './article-metadata'
import { clusterAndPublish } from './cluster'
import { extractArticleText } from './extract'
import { fetchFeed } from './rss'
import { RIGHTS_POLICY_VERSION, rightsForSource } from './source-rights'
import { SOURCES, type Source } from './sources'
import { matchTopic } from './topics'

// Override for one-off backfills: INGEST_MAX_ITEMS=50 npm run ingest
const MAX_ITEMS_PER_FEED = Number(process.env.INGEST_MAX_ITEMS) || 10
// Headlines carry less evidence than copied article bodies. Curated feeds are
// already politics-focused, so keep a modest gate and report low confidence
// instead of silently losing relevant coverage.
const MIN_RELEVANCE = 0.1
const CLEARLY_NONPOLITICAL_CATEGORY =
  /\b(?:sports?|entertainment|celebrity|fashion|food|recipes?|travel|horoscope|gaming)\b/i

export type IngestStats = {
  feedsOk: number
  feedsFailed: number
  seen: number
  inserted: number
  skippedDuplicate: number
  skippedIrrelevant: number
  sourcesFailed: string[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function isDatabaseConnectionError(err: unknown) {
  const value = err as { code?: string; message?: string }
  return (
    ['57P01', '57P02', '57P03', '08000', '08003', '08006', 'ECONNRESET', 'ETIMEDOUT'].includes(
      String(value?.code ?? '')
    ) ||
    /connection|database.*timeout|terminat|ECONNRESET|socket/i.test(String(value?.message ?? ''))
  )
}

export async function withRetry<T>(
  label: string,
  operation: () => Promise<T>,
  shouldRetry: (err: unknown) => boolean,
  attempts = 3
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation()
    } catch (err) {
      lastError = err
      if (attempt === attempts || !shouldRetry(err)) throw err
      const delay = 500 * 2 ** (attempt - 1)
      console.warn(`[ingest] ${label} failed; retrying in ${delay}ms`)
      await sleep(delay)
    }
  }
  throw lastError
}

const dbQuery = (text: string, params?: unknown[]) =>
  withRetry('database operation', () => query(text, params), isDatabaseConnectionError)

async function ingestSource(source: Source, stats: IngestStats) {
  const rights = rightsForSource(source.slug)
  if (rights.acquisition === 'disabled') return
  let hadFeedFailure = false
  for (const feedUrl of source.feeds) {
    let items
    try {
      items = await withRetry(
        `feed ${source.name}`,
        () => fetchFeed(feedUrl),
        () => true
      )
      stats.feedsOk++
    } catch (err) {
      stats.feedsFailed++
      hadFeedFailure = true
      console.warn(`[ingest] feed failed: ${(err as Error).message}`)
      continue
    }

    for (const item of items.slice(0, MAX_ITEMS_PER_FEED)) {
      stats.seen++
      if (!item.title) continue

      // Cheap dedupe before any additional processing. Ingestion never falls
      // through to a publisher-page fetch unless a reviewed policy explicitly
      // enables that mode (none do in the initial registry).
      const contentHash = createHash('sha256')
        .update(`${source.name}::${item.title.toLowerCase()}`)
        .digest('hex')
      const dup = await dbQuery(
        'SELECT 1 FROM articles WHERE url = $1 OR content_hash = $2 LIMIT 1',
        [item.url, contentHash]
      )
      if (dup.rows.length > 0) {
        stats.skippedDuplicate++
        continue
      }

      const extracted = await extractArticleText(item, rights)
      const metadata = buildArticleMetadata(item.title, source.name, item.categories)
      const analysisText = [
        extracted.analysisText,
        item.categories.slice(0, 8).join(' '),
      ].filter(Boolean).join(' ')
      const score = scoreArticle({
        title: item.title,
        content: analysisText,
        url: item.url,
        sourcePrior: source.lean,
        categories: item.categories,
      })
      const clearlyNonpolitical = item.categories.some((category) =>
        CLEARLY_NONPOLITICAL_CATEGORY.test(category)
      )
      const politicalRelevance =
        rights.analysis === 'metadata_only' && !clearlyNonpolitical
          ? Math.max(score.political_relevance, 0.25)
          : score.political_relevance

      if (politicalRelevance < MIN_RELEVANCE) {
        stats.skippedIrrelevant++
        continue
      }

      const topic = await matchTopic(metadata.searchText)
      const leanSignals = [
        ...score.lean_signals,
        `rights:${rights.analysis}`,
        `policy:${RIGHTS_POLICY_VERSION}`,
      ]

      const inserted = await dbQuery(
        `INSERT INTO articles
           (url, content_hash, title, source, content, description, media,
            political_lean, political_relevance, lean_confidence,
            content_type, lean_signals, source_lean, scorer_version,
            general_topic_id, hashtags, entities, event_terms, search_text,
            text_mode, image_mode, ai_mode, rights_policy_version,
            published_at, status)
         VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
           $19,$20,$21,$22,$23,$24,'ready'
         )
         ON CONFLICT DO NOTHING`,
        [
          item.url, contentHash, item.title, source.name,
          extracted.analysisText || null, extracted.publicDescription, extracted.imageUrl,
          score.political_lean, politicalRelevance, score.lean_confidence,
          score.content_type, leanSignals, source.lean, score.scorer_version,
          topic.generalTopicId, metadata.hashtags, metadata.entities,
          metadata.eventTerms, metadata.searchText,
          rights.publicText, rights.image, rights.ai, RIGHTS_POLICY_VERSION,
          extracted.publishedAt,
        ]
      )
      stats.inserted += inserted.rowCount ?? 0
      await sleep(25)
    }
  }
  if (hadFeedFailure && !stats.sourcesFailed.includes(source.name)) {
    stats.sourcesFailed.push(source.name)
  }
}

export async function runIngest(): Promise<IngestStats> {
  const stats: IngestStats = {
    feedsOk: 0, feedsFailed: 0, seen: 0,
    inserted: 0, skippedDuplicate: 0, skippedIrrelevant: 0,
    sourcesFailed: [],
  }
  const started = Date.now()
  const lockClient = await pool.connect()
  let runId: string | null = null
  let locked = false
  try {
    const lock = await lockClient.query(
      "SELECT pg_try_advisory_lock(hashtext('forum-hourly-ingest')) AS locked"
    )
    locked = !!lock.rows[0]?.locked
    if (!locked) {
      await query(
        `INSERT INTO ingest_runs (status, completed_at, duration_ms)
         VALUES ('skipped_locked', NOW(), 0)`
      )
      console.log('[ingest] another run holds the advisory lock; skipping')
      return stats
    }

    const run = await query(`INSERT INTO ingest_runs DEFAULT VALUES RETURNING id`)
    runId = run.rows[0].id
    console.log(`[ingest] starting run across ${SOURCES.length} sources`)

    for (const source of SOURCES) {
      try {
        await withRetry(
          `source ${source.name}`,
          () => ingestSource(source, stats),
          isDatabaseConnectionError
        )
      } catch (err) {
        if (!stats.sourcesFailed.includes(source.name)) stats.sourcesFailed.push(source.name)
        console.warn(`[ingest] source ${source.name} failed: ${(err as Error).message}`)
      }
    }

    // Re-cluster whenever fresh articles arrived so hot topics stay current.
    if (stats.inserted > 0) await clusterAndPublish()

    const status = stats.sourcesFailed.length || stats.feedsFailed ? 'partial' : 'success'
    const duration = Date.now() - started
    await query(
      `UPDATE ingest_runs
       SET status = $2, feeds_ok = $3, feeds_failed = $4, sources_failed = $5,
           seen = $6, inserted = $7, skipped_duplicate = $8,
           skipped_irrelevant = $9, completed_at = NOW(), duration_ms = $10
       WHERE id = $1`,
      [
        runId,
        status,
        stats.feedsOk,
        stats.feedsFailed,
        stats.sourcesFailed,
        stats.seen,
        stats.inserted,
        stats.skippedDuplicate,
        stats.skippedIrrelevant,
        duration,
      ]
    )

    console.log(
      `[ingest] done in ${Math.round(duration / 1000)}s — ` +
        `${stats.inserted} inserted, ${stats.skippedDuplicate} duplicate, ` +
        `${stats.skippedIrrelevant} irrelevant, ${stats.feedsFailed} feed(s) failed`
    )

    for (const source of stats.sourcesFailed) {
      const repeated = await query(
        `SELECT count(*)::int AS failures
         FROM (
           SELECT sources_failed FROM ingest_runs
           WHERE status IN ('partial', 'failed')
           ORDER BY started_at DESC LIMIT 3
         ) recent
         WHERE $1 = ANY(recent.sources_failed)`,
        [source]
      )
      if (Number(repeated.rows[0]?.failures) >= 3) {
        captureMessage(`Ingest source repeatedly failing: ${source}`, 'warning', { source })
      }
    }
    const freshness = await query(
      `SELECT max(COALESCE(published_at, created_at)) AS newest FROM articles WHERE status = 'ready'`
    )
    const newest = freshness.rows[0]?.newest
      ? new Date(freshness.rows[0].newest).getTime()
      : 0
    if (!newest || Date.now() - newest > 8 * 60 * 60_000) {
      captureMessage('Article corpus is stale after ingest', 'error', {
        newest: freshness.rows[0]?.newest ?? null,
      })
    }
    return stats
  } catch (err: any) {
    if (runId) {
      await query(
        `UPDATE ingest_runs
         SET status = 'failed', error = $2, completed_at = NOW(), duration_ms = $3,
             feeds_ok = $4, feeds_failed = $5, sources_failed = $6,
             seen = $7, inserted = $8, skipped_duplicate = $9,
             skipped_irrelevant = $10
         WHERE id = $1`,
        [
          runId,
          String(err?.message ?? err).slice(0, 500),
          Date.now() - started,
          stats.feedsOk,
          stats.feedsFailed,
          stats.sourcesFailed,
          stats.seen,
          stats.inserted,
          stats.skippedDuplicate,
          stats.skippedIrrelevant,
        ]
      ).catch(() => {})
    }
    captureException(err, { component: 'ingest' })
    throw err
  } finally {
    if (locked) {
      await lockClient
        .query("SELECT pg_advisory_unlock(hashtext('forum-hourly-ingest'))")
        .catch(() => {})
    }
    lockClient.release()
  }
}
