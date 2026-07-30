// One-off: derive hashtags for articles ingested before the hashtag
// column existed. Safe to re-run (only touches rows with empty tags).
import 'dotenv/config'
import pool, { query } from '../src/db'
import { extractKeywords, toHashtags } from '../src/ingest/keywords'

async function main() {
  const { rows } = await query(
    `SELECT id, title, content FROM articles
     WHERE (hashtags IS NULL OR hashtags = '{}') AND content IS NOT NULL`
  )
  for (const a of rows) {
    const tags = toHashtags(extractKeywords(a.title ?? '', a.content).top)
    await query('UPDATE articles SET hashtags = $2 WHERE id = $1', [a.id, tags])
  }
  console.log(`[backfill] hashtags added to ${rows.length} articles`)
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => pool.end())
