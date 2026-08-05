// CLI entry: `npm run rescore`
// Re-runs the current scorer over every article and post. Article pages are
// fetched transiently; publisher bodies are never read from or written to the
// database.
// Run this after any lexicon/weight/prior change (with SCORER_VERSION
// bumped) so all stored scores are on the same scale again. Safe to
// run deliberately because it performs polite publisher refetches.

import 'dotenv/config'
import pool, { query } from '../db'
import { extractArticleText } from '../ingest/extract'
import { extractKeywords, keywordSearchText, storeKeywords } from '../ingest/keywords'
import { sourcePrior } from '../ingest/sources'
import { semanticEmbedding } from '../recommendation/semantic'
import {
  ARTICLE_SCORER_VERSION,
  POST_SCORER_VERSION,
  scoreArticle,
  scorePost,
} from './score'

async function rescoreArticles(): Promise<number> {
  const { rows } = await query(
    `SELECT id, url, title, source, media, published_at
     FROM articles WHERE status = 'ready' ORDER BY published_at DESC NULLS LAST`
  )
  for (const a of rows) {
    const extracted = await extractArticleText({
      title: a.title ?? '',
      url: a.url,
      summary: '',
      contentHtml: '',
      publishedAt: a.published_at ? new Date(a.published_at) : null,
      categories: [],
      imageUrl: a.media ?? null,
    })
    const score = scoreArticle({
      title: a.title ?? '',
      content: extracted.text,
      url: a.url,
      sourcePrior: sourcePrior(a.source),
    })
    const profile = storeKeywords(extractKeywords(a.title ?? '', extracted.text))
    await query(
      `UPDATE articles SET
         political_lean = $2, political_relevance = $3, lean_confidence = $4,
         content_type = $5, lean_signals = $6, source_lean = $7, scorer_version = $8,
         analysis_profile = $9, analysis_text = $10, recommendation_embedding = $11
       WHERE id = $1`,
      [
        a.id, score.political_lean, score.political_relevance,
        score.lean_confidence, score.content_type, score.lean_signals,
        sourcePrior(a.source) ?? null, score.scorer_version,
        profile, keywordSearchText(profile),
        semanticEmbedding(`${a.title ?? ''}. ${a.title ?? ''}. ${extracted.text}`),
      ]
    )
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return rows.length
}

async function rescorePosts(): Promise<number> {
  const { rows } = await query("SELECT id, content FROM posts WHERE content IS NOT NULL AND content <> ''")
  for (const p of rows) {
    const score = scorePost(p.content)
    await query(
      `UPDATE posts SET
         position = $2, position_confidence = $3, position_signals = $4, scorer_version = $5
       WHERE id = $1`,
      [p.id, score.position, score.confidence, score.signals, score.scorer_version]
    )
  }
  return rows.length
}

async function main() {
  console.log(`[rescore] applying article ${ARTICLE_SCORER_VERSION} and post ${POST_SCORER_VERSION}`)
  const articles = await rescoreArticles()
  const posts = await rescorePosts()
  console.log(`[rescore] done — ${articles} articles, ${posts} posts`)
}

main()
  .catch((err) => {
    console.error('[rescore] fatal:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
