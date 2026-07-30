// One-off: derive hashtags for articles ingested before the hashtag
// column existed. Safe to re-run (only touches rows with empty tags).
import 'dotenv/config'
import pool, { query } from '../src/db'
import { buildArticleMetadata } from '../src/ingest/article-metadata'

async function main() {
  const { rows } = await query(
    `SELECT id, title, source FROM articles
     WHERE hashtags IS NULL OR hashtags = '{}'`
  )
  for (const a of rows) {
    const tags = buildArticleMetadata(a.title ?? '', a.source ?? '').hashtags
    await query('UPDATE articles SET hashtags = $2 WHERE id = $1', [a.id, tags])
  }
  console.log(`[backfill] hashtags added to ${rows.length} articles`)
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => pool.end())
