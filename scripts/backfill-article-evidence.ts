import 'dotenv/config'
import pool from '../src/db'
import { buildStructuredEvidence } from '../src/ingest/article-evidence'
import { cacheManagedArticleImage, managedArticleImagesConfigured } from '../src/ingest/article-image'
import { extractArticleText } from '../src/ingest/extract'
import { RIGHTS_POLICY_VERSION, rightsForSource } from '../src/ingest/source-rights'
import { SOURCES } from '../src/ingest/sources'

const APPLY = process.env.APPLY_ARTICLE_ANALYSIS_BACKFILL === 'true'
const LIMIT = Math.max(1, Number(process.env.ARTICLE_BACKFILL_LIMIT ?? 50))
const slugByName = new Map(SOURCES.map((source) => [source.name, source.slug]))

async function main() {
  const candidates = await pool.query(
    `SELECT a.id, a.url, a.title, a.source, a.media, a.published_at
     FROM articles a
     LEFT JOIN article_evidence e ON e.article_id = a.id
     WHERE a.status = 'ready'
       AND (e.article_id IS NULL OR a.rights_policy_version IS DISTINCT FROM $1)
     ORDER BY COALESCE(a.published_at, a.created_at) DESC
     LIMIT $2`,
    [RIGHTS_POLICY_VERSION, LIMIT]
  )
  if (!APPLY) {
    console.log(JSON.stringify({
      apply: false,
      candidates: candidates.rowCount ?? 0,
      limit: LIMIT,
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
      const rights = rightsForSource(slugByName.get(sourceName) ?? '')
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
               entities = $2, event_terms = $3, search_text = $4,
               rights_policy_version = $5, ai_mode = $6,
               media_source_url = $7,
               media = COALESCE($8, $7),
               media_thumbnail_url = $9,
               media_large_url = $8,
               media_width = $10,
               media_height = $11,
               media_source_hash = $12,
               media_status = CASE WHEN $7::text IS NULL THEN 'none'
                                   WHEN $8::text IS NOT NULL THEN 'ready'
                                   ELSE 'ready' END,
               media_cached_at = CASE WHEN $8::text IS NOT NULL THEN NOW() ELSE NULL END,
               media_expires_at = $13,
               image_mode = CASE WHEN $7::text IS NULL THEN 'none'
                                 WHEN $8::text IS NOT NULL THEN 'managed_thumbnail'
                                 ELSE 'remote_no_cache' END
           WHERE id = $1`,
          [
            row.id, evidence.entities, evidence.eventTerms, evidence.searchText,
            RIGHTS_POLICY_VERSION, rights.ai, sourceImage, cached?.largeUrl ?? null,
            cached?.thumbnailUrl ?? null, cached?.width ?? null, cached?.height ?? null,
            cached?.sourceHash ?? null, cached?.expiresAt ?? null,
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
