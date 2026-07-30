import 'dotenv/config'
import pool from '../src/db'
import { deletePrefix, publicStorageConfigured } from '../src/lib/r2'

const APPLY = process.env.APPLY_ARTICLE_IMAGE_EXPIRY === 'true'
const LIMIT = Math.max(1, Number(process.env.ARTICLE_IMAGE_EXPIRY_LIMIT ?? 100))

async function main() {
  const result = await pool.query(
    `SELECT id, media_source_url
     FROM articles
     WHERE image_mode = 'managed_thumbnail'
       AND media_expires_at < NOW()
     ORDER BY media_expires_at
     LIMIT $1`,
    [LIMIT]
  )
  if (!APPLY) {
    console.log(JSON.stringify({
      apply: false,
      expired: result.rowCount ?? 0,
      note: 'Set APPLY_ARTICLE_IMAGE_EXPIRY=true to purge this batch.',
    }, null, 2))
    return
  }
  if (!publicStorageConfigured()) throw new Error('Public R2 storage is not configured')
  let purged = 0
  for (const row of result.rows) {
    await deletePrefix(process.env.R2_BUCKET_NAME!, `articles/${row.id}/`)
    await pool.query(
      `UPDATE articles
       SET media = media_source_url, media_thumbnail_url = NULL,
           media_large_url = NULL, media_source_hash = NULL,
           media_cached_at = NULL, media_expires_at = NULL,
           media_status = CASE WHEN media_source_url IS NULL THEN 'none' ELSE 'ready' END,
           image_mode = CASE WHEN media_source_url IS NULL THEN 'none' ELSE 'remote_no_cache' END
       WHERE id = $1`,
      [row.id]
    )
    purged++
  }
  console.log(JSON.stringify({ apply: true, purged }, null, 2))
}

main()
  .catch((error) => {
    console.error('Article image expiry failed:', error)
    process.exitCode = 1
  })
  .finally(() => pool.end())

