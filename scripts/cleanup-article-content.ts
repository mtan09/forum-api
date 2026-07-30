import 'dotenv/config'
import pool from '../src/db'

const APPLY = process.env.APPLY_ARTICLE_RIGHTS_CLEANUP === 'true'

async function main() {
  const audit = await pool.query(
    `SELECT
       count(*)::int AS articles,
       count(*) FILTER (WHERE content IS NOT NULL AND length(content) > 0)::int AS bodies,
       count(*) FILTER (WHERE media IS NOT NULL AND length(media) > 0)::int AS media_urls,
       COALESCE(sum(length(content)), 0)::bigint AS body_characters
     FROM articles`
  )
  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', ...audit.rows[0] }, null, 2))

  if (!APPLY) {
    console.log(
      'No data changed. Set APPLY_ARTICLE_RIGHTS_CLEANUP=true only after reviewing this audit.'
    )
    return
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const cleared = await client.query(
      `UPDATE articles
       SET content = NULL,
           media = CASE
             WHEN image_mode IN ('remote_no_cache', 'licensed_cache') THEN media
             ELSE NULL
           END
       WHERE content IS NOT NULL
          OR (media IS NOT NULL AND image_mode = 'none')`
    )
    await client.query(
      `UPDATE subtopics
       SET image_urls = '{}'
       WHERE image_urls IS NOT NULL AND cardinality(image_urls) > 0`
    )
    await client.query('COMMIT')
    console.log(`Cleared restricted article data from ${cleared.rowCount ?? 0} rows`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

main()
  .catch((err) => {
    console.error('Article cleanup failed:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
