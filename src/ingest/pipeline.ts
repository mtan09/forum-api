// Ingestion pipeline: RSS feeds → dedupe → extract text → relevance
// gate → deterministic scoring → insert as 'ready'. Idempotent — the
// articles.url and articles.content_hash UNIQUE constraints make
// re-runs no-ops for already-seen items.

import { createHash } from 'node:crypto'
import pool, { query } from '../db'
import { captureException, captureMessage } from '../lib/sentry'
import { scoreArticle } from '../scoring/score'
import { semanticEmbedding } from '../recommendation/semantic'
import { clusterAndPublish } from './cluster'
import { extractArticleText } from './extract'
import { extractKeywords, keywordSearchText, storeKeywords, toHashtags } from './keywords'
import { fetchFeed } from './rss'
import { sourceAllowsAiContext, SOURCES, type Source } from './sources'
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

      // Cheap dedupe before doing any page fetching
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
      const keywordProfile = extractKeywords(item.title, extracted.text)
      const storedProfile = storeKeywords(keywordProfile)
      // Auto-hashtags from the article's own keywords; subtopic_id is
      // assigned afterwards by the clustering pass, not here
      const hashtags = toHashtags(keywordProfile.top)

      const inserted = await dbQuery(
        `INSERT INTO articles
           (url, content_hash, title, source, media,
            political_lean, political_relevance, lean_confidence,
            content_type, lean_signals, source_lean, scorer_version,
            general_topic_id, hashtags, published_at, recommendation_embedding,
            analysis_profile, analysis_text, ai_context_allowed, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'ready')
         ON CONFLICT DO NOTHING`,
        [
          item.url, contentHash, item.title, source.name,
          extracted.imageUrl,
          score.political_lean, score.political_relevance, score.lean_confidence,
          score.content_type, score.lean_signals, source.lean, score.scorer_version,
          topic.generalTopicId, hashtags, extracted.publishedAt,
          semanticEmbedding(`${item.title}. ${item.title}. ${extracted.text}`),
          storedProfile, keywordSearchText(storedProfile), sourceAllowsAiContext(source.name),
        ]
      )
      stats.inserted += inserted.rowCount ?? 0
      await sleep(250) // stay polite to article pages
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
  let lockHeartbeat: NodeJS.Timeout | null = null
  let heartbeatInFlight: Promise<void> | null = null
  let lockFailure: unknown = null
  const onLockError = (error: Error) => {
    lockFailure ??= error
  }
  try {
    // The advisory lock lives on this checked-out PgBouncer connection. The
    // ingest work itself uses the regular pool, so without a heartbeat this
    // transaction is otherwise idle long enough for Neon to terminate it.
    lockClient.on('error', onLockError)
    await lockClient.query('BEGIN')
    const lock = await lockClient.query(
      "SELECT pg_try_advisory_xact_lock(hashtext('forum-hourly-ingest')) AS locked"
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

    const heartbeat = () => {
      if (heartbeatInFlight) return
      heartbeatInFlight = lockClient.query('SELECT 1')
        .then(() => undefined)
        .catch((error) => {
          lockFailure ??= error
        })
        .finally(() => {
          heartbeatInFlight = null
        })
    }
    lockHeartbeat = setInterval(heartbeat, 60_000)
    lockHeartbeat.unref()

    // Holding the advisory lock proves that no live ingest worker owns it.
    // Any older "running" rows were abandoned by a crashed process.
    await query(
      `UPDATE ingest_runs
       SET status = 'failed', completed_at = NOW(),
           duration_ms = LEAST(
             2147483647,
             GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)
           )::int,
           error = COALESCE(error, 'Previous ingest process exited before recording completion.')
       WHERE status = 'running' AND completed_at IS NULL`
    )

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
      if (lockFailure) throw lockFailure
    }

    // Re-cluster whenever fresh articles arrived so hot topics stay current.
    if (stats.inserted > 0) await clusterAndPublish()
    if (lockFailure) throw lockFailure

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
    // Transaction-scoped locks are safe through PgBouncer and cannot remain
    // attached to a pooled Neon backend after this process exits. Stop and
    // drain the heartbeat before rolling the transaction back.
    if (lockHeartbeat) clearInterval(lockHeartbeat)
    await Promise.resolve(heartbeatInFlight).catch(() => undefined)
    await lockClient.query('ROLLBACK').catch(() => {})
    lockClient.removeListener('error', onLockError)
    lockClient.release()
  }
}
