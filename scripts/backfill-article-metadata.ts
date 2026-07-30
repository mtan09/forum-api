import 'dotenv/config'
import pool from '../src/db'
import { buildArticleMetadata } from '../src/ingest/article-metadata'
import { RIGHTS_POLICY_VERSION, rightsForSource } from '../src/ingest/source-rights'
import { SOURCES } from '../src/ingest/sources'

const slugByName = new Map(SOURCES.map((source) => [source.name, source.slug]))

async function main() {
  const result = await pool.query(
    `SELECT id, title, source FROM articles ORDER BY created_at, id`
  )
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const batchSize = 250
    for (let offset = 0; offset < result.rows.length; offset += batchSize) {
      const rows = result.rows.slice(offset, offset + batchSize)
      const params: unknown[] = []
      const values = rows.map((row, index) => {
        const title = String(row.title ?? '')
        const source = String(row.source ?? '')
        const slug = slugByName.get(source) ?? ''
        const rights = rightsForSource(slug)
        const metadata = buildArticleMetadata(title, source)
        params.push(
          row.id,
          metadata.entities,
          metadata.eventTerms,
          metadata.hashtags,
          metadata.searchText,
          rights.publicText,
          RIGHTS_POLICY_VERSION
        )
        const p = index * 7
        return `(
          $${p + 1}::uuid, $${p + 2}::text[], $${p + 3}::text[],
          $${p + 4}::text[], $${p + 5}::text, $${p + 6}::text,
          $${p + 7}::text
        )`
      })
      await client.query(
        `UPDATE articles AS article
         SET entities = value.entities,
             event_terms = value.event_terms,
             hashtags = value.hashtags,
             search_text = value.search_text,
             text_mode = value.text_mode,
             image_mode = CASE WHEN article.media IS NULL THEN 'none' ELSE 'remote_no_cache' END,
             ai_mode = 'metadata_only',
             rights_policy_version = value.rights_policy_version
         FROM (VALUES ${values.join(',')}) AS value(
           id, entities, event_terms, hashtags, search_text,
           text_mode, rights_policy_version
         )
         WHERE article.id = value.id`,
        params
      )
    }
    await client.query('COMMIT')
    console.log(`Backfilled rights-safe metadata for ${result.rowCount ?? 0} articles`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error('Article metadata backfill failed:', err)
  process.exitCode = 1
})
