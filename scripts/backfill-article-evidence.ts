import 'dotenv/config'
import pool from '../src/db'
import { buildStructuredEvidence } from '../src/ingest/article-evidence'
import { cacheManagedArticleImage, managedArticleImagesConfigured } from '../src/ingest/article-image'
import { extractArticleText } from '../src/ingest/extract'
import { toHashtags } from '../src/ingest/keywords'
import { RIGHTS_POLICY_VERSION, rightsForSource } from '../src/ingest/source-rights'
import { SOURCES } from '../src/ingest/sources'
import { matchTopic } from '../src/ingest/topics'
import { scoreArticle } from '../src/scoring/score'

const APPLY = process.env.APPLY_ARTICLE_ANALYSIS_BACKFILL === 'true'
const LIMIT = Math.max(1, Number(process.env.ARTICLE_BACKFILL_LIMIT ?? 50))
const DAYS = Math.max(1, Number(process.env.ARTICLE_BACKFILL_DAYS ?? 14))
const sourceByName = new Map(SOURCES.map((source) => [source.name, source]))

async function main() {
  const candidates = await pool.query(
    `SELECT a.id, a.url, a.title, a.source, a.media, a.published_at
     FROM articles a
     LEFT JOIN article_evidence e ON e.article_id = a.id
     WHERE a.status = 'ready'
       AND (e.article_id IS NULL OR a.rights_policy_version IS DISTINCT FROM $1)
       AND COALESCE(a.published_at, a.created_at) > NOW() - ($3 * INTERVAL '1 day')
       AND COALESCE(a.political_relevance, 0) >= 0.1
     ORDER BY COALESCE(a.published_at, a.created_at) DESC
     LIMIT $2`,
    [RIGHTS_POLICY_VERSION, LIMIT, DAYS]
  )
  if (!APPLY) {
    console.log(JSON.stringify({
      apply: false,
      candidates: candidates.rowCount ?? 0,
      limit: LIMIT,
      days: DAYS,
      note: 'Set APPLY_ARTICLE_ANALYSIS_BACKFILL=true to process this batch.',
    }, null, 2))
    return
  }

  let completed = 0
  let failed = 0
  let managedImages = 0
  for (const row of candidates.rows) {
    try {
      const sourceName = String(row.source ?? '')
      const source = sourceByName.get(sourceName)
      const rights = rightsForSource(source?.slug ?? '')
      const extracted = await extractArticleText({
        title: String(row.title ?? ''),
        url: String(row.url),
        summary: '',
        contentHtml: '',
        publishedAt: row.published_at ? new Date(row.published_at) : null,
        categories: [],
        imageUrl: row.media ? String(row.media) : null,
      }, rights)
      const evidence = await buildStructuredEvidence({
        title: String(row.title ?? ''),
        source: sourceName,
        categories: [],
        analysisText: extracted.analysisText,
        extractionMethod: extracted.analysisMethod,
      })
      const score = scoreArticle({
        title: String(row.title ?? ''),
        content: extracted.analysisText,
        url: String(row.url),
        sourcePrior: source?.lean,
        categories: [],
      })
      const topic = await matchTopic(evidence.searchText)
      const sourceImage = extracted.imageUrl
      const wantsManaged = Boolean(
        sourceImage &&
        rights.image === 'managed_thumbnail' &&
        managedArticleImagesConfigured()
      )
      const cached = wantsManaged
        ? await cacheManagedArticleImage(String(row.id), sourceImage!)
        : null
      if (cached) managedImages++

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO article_evidence
             (article_id, extraction_version, source_text_hash, word_count,
              evidence_summary, claims, timeline, relationships, disputed_points,
              entities, event_terms, search_text, extraction_method, confidence,
              generated_by)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,
                   $10,$11,$12,$13,$14,$15)
           ON CONFLICT (article_id) DO UPDATE SET
             extraction_version = EXCLUDED.extraction_version,
             source_text_hash = EXCLUDED.source_text_hash,
             word_count = EXCLUDED.word_count,
             evidence_summary = EXCLUDED.evidence_summary,
             claims = EXCLUDED.claims,
             timeline = EXCLUDED.timeline,
             relationships = EXCLUDED.relationships,
             disputed_points = EXCLUDED.disputed_points,
             entities = EXCLUDED.entities,
             event_terms = EXCLUDED.event_terms,
             search_text = EXCLUDED.search_text,
             extraction_method = EXCLUDED.extraction_method,
             confidence = EXCLUDED.confidence,
             generated_by = EXCLUDED.generated_by,
             updated_at = NOW()`,
          [
            row.id, evidence.extractionVersion, evidence.sourceTextHash,
            evidence.wordCount, evidence.summary, JSON.stringify(evidence.claims),
            JSON.stringify(evidence.timeline), JSON.stringify(evidence.relationships),
            JSON.stringify(evidence.disputedPoints), evidence.entities,
            evidence.eventTerms, evidence.searchText, evidence.extractionMethod,
            evidence.confidence, evidence.generatedBy,
          ]
        )
        await client.query(
          `UPDATE articles
           SET content = NULL,
               entities = $2, event_terms = $3, hashtags = $4, search_text = $5,
               rights_policy_version = $6, ai_mode = $7,
               media_source_url = $8,
               media = COALESCE($9, $8),
               media_thumbnail_url = $10,
               media_large_url = $9,
               media_width = $11,
               media_height = $12,
               media_source_hash = $13,
               media_status = CASE WHEN $8::text IS NULL THEN 'none'
                                   WHEN $9::text IS NOT NULL THEN 'ready'
                                   ELSE 'ready' END,
               media_cached_at = CASE WHEN $9::text IS NOT NULL THEN NOW() ELSE NULL END,
               media_expires_at = $14,
               image_mode = CASE WHEN $8::text IS NULL THEN 'none'
                                 WHEN $9::text IS NOT NULL THEN 'managed_thumbnail'
                                 ELSE 'remote_no_cache' END,
               political_lean = $15,
               political_relevance = $16,
               lean_confidence = $17,
               content_type = $18,
               lean_signals = $19,
               source_lean = $20,
               scorer_version = $21,
               general_topic_id = $22
           WHERE id = $1`,
          [
            row.id,
            evidence.entities,
            evidence.eventTerms,
            toHashtags(evidence.eventTerms),
            evidence.searchText,
            RIGHTS_POLICY_VERSION,
            rights.ai,
            sourceImage,
            cached?.largeUrl ?? null,
            cached?.thumbnailUrl ?? null,
            cached?.width ?? null,
            cached?.height ?? null,
            cached?.sourceHash ?? null,
            cached?.expiresAt ?? null,
            score.political_lean,
            score.political_relevance,
            score.lean_confidence,
            score.content_type,
            [
              ...score.lean_signals,
              `rights:${rights.analysis}`,
              `evidence:${evidence.generatedBy}`,
              `extraction:${extracted.analysisMethod}`,
              `policy:${RIGHTS_POLICY_VERSION}`,
            ],
            source?.lean ?? null,
            score.scorer_version,
            topic.generalTopicId,
          ]
        )
        await client.query('COMMIT')
        completed++
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    } catch (error) {
      failed++
      console.warn(
        `[article-backfill] failed article ${row.id} from ${row.source}: ` +
        String((error as Error)?.message ?? error).slice(0, 180)
      )
    }
  }
  console.log(JSON.stringify({ apply: true, completed, failed, managedImages }, null, 2))
}

main()
  .catch((error) => {
    console.error('Article evidence backfill failed:', error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
