// Guarded post-only scorer backfill. The default invocation is read-only.
// Usage: npm run rescore:posts
//        npm run rescore:posts -- --apply

import 'dotenv/config'
import pool, { query } from '../db'
import { POST_SCORER_VERSION, scorePost } from './score'

type PostRow = { id: string; content: string | null }

async function main() {
  const apply = process.argv.includes('--apply')
  const result = await query('SELECT id, content FROM posts ORDER BY created_at, id')
  const rows = result.rows as PostRow[]
  const scores = rows.map((post) => ({ id: post.id, score: scorePost(post.content ?? '') }))
  const classified = scores.filter((entry) => entry.score.position != null).length

  if (!apply) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      scorer: POST_SCORER_VERSION,
      posts: scores.length,
      classified,
      unclassified: scores.length - classified,
      next: 'Re-run with --apply after reviewing npm run audit:posts.',
    }, null, 2))
    return
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('forum-post-spectrum-rescore'))")
    for (const { id, score } of scores) {
      await client.query(
        `UPDATE posts SET
           position = $2,
           position_confidence = $3,
           position_signals = $4,
           scorer_version = $5
         WHERE id = $1`,
        [id, score.position, score.confidence, score.signals, score.scorer_version]
      )
    }
    const verification = await client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE scorer_version = $1)::int AS current_version
       FROM posts`,
      [POST_SCORER_VERSION]
    )
    const counts = verification.rows[0]
    if (Number(counts.current_version) !== Number(counts.total)) {
      throw new Error(`Version verification failed: ${counts.current_version}/${counts.total}`)
    }
    await client.query('COMMIT')
    console.log(JSON.stringify({
      mode: 'applied',
      scorer: POST_SCORER_VERSION,
      posts: scores.length,
      classified,
      unclassified: scores.length - classified,
    }, null, 2))
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

main()
  .catch((err) => {
    console.error('[rescore:posts] fatal:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
