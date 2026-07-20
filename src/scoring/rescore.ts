// CLI entry: `npm run rescore`
// Re-runs the current scorer over every stored article and post.
// Run this after any lexicon/weight/prior change (with SCORER_VERSION
// bumped) so all stored scores are on the same scale again. Safe to
// run anytime — it's a pure recomputation from stored text.

import 'dotenv/config'
import pool, { query } from '../db'
import { sourcePrior } from '../ingest/sources'
import { scoreArticle, scorePost, SCORER_VERSION } from './score'

async function rescoreArticles(): Promise<number> {
  const { rows } = await query(
    'SELECT id, url, title, source, content FROM articles WHERE content IS NOT NULL'
  )
  for (const a of rows) {
    const score = scoreArticle({
      title: a.title ?? '',
      content: a.content,
      url: a.url,
      sourcePrior: sourcePrior(a.source),
    })
    await query(
      `UPDATE articles SET
         political_lean = $2, political_relevance = $3, lean_confidence = $4,
         content_type = $5, lean_signals = $6, source_lean = $7, scorer_version = $8
       WHERE id = $1`,
      [
        a.id, score.political_lean, score.political_relevance,
        score.lean_confidence, score.content_type, score.lean_signals,
        sourcePrior(a.source) ?? null, score.scorer_version,
      ]
    )
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
  console.log(`[rescore] applying scorer ${SCORER_VERSION}`)
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
