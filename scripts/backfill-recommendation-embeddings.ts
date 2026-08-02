import 'dotenv/config'
import pool from '../src/db'
import { semanticEmbedding } from '../src/recommendation/semantic'

const BATCH = 100
const MAX_RECENT_ARTICLES = 2_500

async function backfillPosts() {
  let updated = 0
  for (;;) {
    const rows = await pool.query(
      `SELECT id, content FROM posts
       WHERE recommendation_embedding IS NULL
       ORDER BY created_at DESC LIMIT $1`,
      [BATCH]
    )
    if (rows.rows.length === 0) return updated
    const payload = rows.rows.map((row) => ({
      id: row.id,
      embedding: semanticEmbedding(String(row.content ?? '')),
    }))
    await pool.query(
      `UPDATE posts p SET recommendation_embedding = values.embedding
       FROM jsonb_to_recordset($1::jsonb) AS values(id uuid, embedding real[])
       WHERE p.id = values.id`,
      [JSON.stringify(payload)]
    )
    updated += rows.rows.length
  }
}

async function backfillArticles() {
  let updated = 0
  while (updated < MAX_RECENT_ARTICLES) {
    const rows = await pool.query(
      `SELECT id, title, content FROM articles
       WHERE recommendation_embedding IS NULL
       ORDER BY published_at DESC NULLS LAST LIMIT $1`,
      [Math.min(BATCH, MAX_RECENT_ARTICLES - updated)]
    )
    if (rows.rows.length === 0) return updated
    const payload = rows.rows.map((row) => ({
      id: row.id,
      embedding: semanticEmbedding(`${row.title ?? ''}. ${row.title ?? ''}. ${row.content ?? ''}`),
    }))
    await pool.query(
      `UPDATE articles a SET recommendation_embedding = values.embedding
       FROM jsonb_to_recordset($1::jsonb) AS values(id uuid, embedding real[])
       WHERE a.id = values.id`,
      [JSON.stringify(payload)]
    )
    updated += rows.rows.length
  }
  return updated
}

Promise.all([backfillPosts(), backfillArticles()])
  .then(([posts, articles]) => console.log(`Backfilled ${posts} posts and ${articles} articles`))
  .finally(() => pool.end())
  .catch((error) => {
    console.error('Recommendation embedding backfill failed:', error)
    process.exitCode = 1
  })
