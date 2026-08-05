import 'dotenv/config'
import pool from '../src/db'
import {
  extractKeywords,
  keywordSearchText,
  keywordSimilarity,
  restoreKeywords,
  storeKeywords,
  toHashtags,
  type Keywords,
} from '../src/ingest/keywords'
import { sourceAllowsAiContext } from '../src/ingest/sources'
import { semanticEmbedding } from '../src/recommendation/semantic'

const APPLY_TOKEN = 'DELETE_STORED_ARTICLE_BODIES'
const BATCH_SIZE = 100
const CLUSTER_THRESHOLD = 0.3
const AUDIT_LIMIT = 400

type ArticleRow = {
  id: string
  title: string | null
  source: string | null
  content: string | null
  analysis_profile: unknown
  recommendation_embedding: number[] | null
  hashtags: string[] | null
  created_at: string
}

function profileFor(row: ArticleRow): Keywords {
  if (row.content) return extractKeywords(row.title ?? '', row.content)
  return restoreKeywords(row.analysis_profile, row.title ?? '')
}

function clusteringAgreement(rows: ArticleRow[]) {
  const sample = rows
    .filter((row) => row.content)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, AUDIT_LIMIT)
  const original = sample.map(profileFor)
  const stored = original.map(storeKeywords)
  const compact = stored.map(restoreKeywords)
  let pairs = 0
  let agreements = 0
  let beforePositive = 0
  let afterPositive = 0
  let added = 0
  let removed = 0
  let originalWeight = 0
  let retainedWeight = 0
  for (let i = 0; i < original.length; i++) {
    originalWeight += [...original[i].terms.values()].reduce((sum, weight) => sum + weight, 0)
    retainedWeight += stored[i].cluster_terms.reduce((sum, [, weight]) => sum + weight, 0)
    for (let j = i + 1; j < original.length; j++) {
      const before = keywordSimilarity(original[i], original[j]) >= CLUSTER_THRESHOLD
      const after = keywordSimilarity(compact[i], compact[j]) >= CLUSTER_THRESHOLD
      pairs++
      if (before) beforePositive++
      if (after) afterPositive++
      if (!before && after) added++
      if (before && !after) removed++
      if (before === after) agreements++
    }
  }
  return {
    articles: sample.length,
    featureWeightRetention: originalWeight ? retainedWeight / originalWeight : 1,
    pairDecisions: pairs,
    pairAgreement: pairs ? agreements / pairs : 1,
    beforePositive,
    afterPositive,
    added,
    removed,
  }
}

async function hasDerivedColumns(): Promise<boolean> {
  const result = await pool.query(
    `SELECT count(*)::int AS count
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'articles'
       AND column_name IN ('analysis_profile', 'analysis_text', 'ai_context_allowed')`
  )
  return Number(result.rows[0]?.count ?? 0) === 3
}

async function loadRows(derivedColumnsExist: boolean): Promise<ArticleRow[]> {
  const result = await pool.query(
    `SELECT id, title, source, content,
            ${derivedColumnsExist ? 'analysis_profile' : 'NULL::jsonb AS analysis_profile'},
            recommendation_embedding, hashtags, created_at
     FROM articles ORDER BY id`
  )
  return result.rows as ArticleRow[]
}

async function applyBatch(rows: ArticleRow[]) {
  const payload = rows.map((row) => {
    const profile = profileFor(row)
    const stored = storeKeywords(profile)
    return {
      id: row.id,
      profile: stored,
      analysis_text: keywordSearchText(stored),
      embedding: row.recommendation_embedding?.length
        ? row.recommendation_embedding
        : semanticEmbedding(`${row.title ?? ''}. ${row.title ?? ''}. ${row.content ?? ''}`),
      hashtags: row.hashtags?.length ? row.hashtags : toHashtags(profile.top),
      ai_context_allowed: sourceAllowsAiContext(row.source),
    }
  })
  await pool.query(
    `UPDATE articles article SET
       analysis_profile = values.profile,
       analysis_text = values.analysis_text,
       recommendation_embedding = values.embedding,
       hashtags = values.hashtags,
       ai_context_allowed = values.ai_context_allowed,
       content = NULL
     FROM jsonb_to_recordset($1::jsonb) AS values(
       id uuid,
       profile jsonb,
       analysis_text text,
       embedding real[],
       hashtags text[],
       ai_context_allowed boolean
     )
     WHERE article.id = values.id`,
    [JSON.stringify(payload)]
  )
}

async function main() {
  const derivedColumnsExist = await hasDerivedColumns()
  const applying = process.env.ARTICLE_BODY_SCRUB === APPLY_TOKEN
  if (applying && !derivedColumnsExist) {
    throw new Error('Apply migration 021 before scrubbing article bodies.')
  }
  const rows = await loadRows(derivedColumnsExist)
  const withBodies = rows.filter((row) => row.content != null).length
  const missingProfiles = rows.filter((row) => !row.analysis_profile).length
  const eligibleForAi = rows.filter((row) => sourceAllowsAiContext(row.source)).length
  const quality = clusteringAgreement(rows)
  console.log(JSON.stringify({
    mode: applying ? 'apply' : 'dry-run',
    migration_021_present: derivedColumnsExist,
    articles: rows.length,
    stored_bodies: withBodies,
    missing_derived_profiles: missingProfiles,
    ai_context_allowed: eligibleForAi,
    ai_context_blocked: rows.length - eligibleForAi,
    clustering_audit: {
      articles: quality.articles,
      cluster_feature_weight_retention: Number(quality.featureWeightRetention.toFixed(4)),
      threshold_pair_decisions: quality.pairDecisions,
      threshold_pair_agreement: Number(quality.pairAgreement.toFixed(4)),
      joins_before: quality.beforePositive,
      joins_after: quality.afterPositive,
      joins_added: quality.added,
      joins_removed: quality.removed,
    },
  }, null, 2))

  if (!applying) {
    console.log(`Dry run only. Set ARTICLE_BODY_SCRUB=${APPLY_TOKEN} to derive features and clear bodies.`)
    return
  }

  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    await applyBatch(rows.slice(offset, offset + BATCH_SIZE))
    console.log(`[article-scrub] processed ${Math.min(offset + BATCH_SIZE, rows.length)}/${rows.length}`)
  }

  const verification = await pool.query(
    `SELECT
       count(*) FILTER (WHERE content IS NOT NULL)::int AS stored_bodies,
       count(*) FILTER (WHERE analysis_profile IS NULL OR analysis_text IS NULL)::int AS missing_profiles
     FROM articles`
  )
  const result = verification.rows[0]
  if (Number(result.stored_bodies) !== 0 || Number(result.missing_profiles) !== 0) {
    throw new Error(`Scrub verification failed: ${JSON.stringify(result)}`)
  }

  await pool.query(
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'articles_content_not_stored'
       ) THEN
         ALTER TABLE articles
           ADD CONSTRAINT articles_content_not_stored CHECK (content IS NULL) NOT VALID;
       END IF;
     END $$;
     ALTER TABLE articles VALIDATE CONSTRAINT articles_content_not_stored;

     -- Remove the temporary legacy-body fallback from the generated search
     -- expression so the live schema matches schema.sql after the scrub.
     DROP INDEX IF EXISTS idx_articles_tsv;
     ALTER TABLE articles DROP COLUMN IF EXISTS search_tsv;
     ALTER TABLE articles ADD COLUMN search_tsv tsvector
       GENERATED ALWAYS AS (
         to_tsvector(
           'english',
           coalesce(title, '') || ' ' || coalesce(analysis_text, '')
         )
       ) STORED;
     CREATE INDEX idx_articles_tsv ON articles USING GIN (search_tsv);`
  )
  console.log('[article-scrub] verified: no stored bodies; database constraint active')
}

main()
  .catch((error) => {
    console.error('[article-scrub] failed:', error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
