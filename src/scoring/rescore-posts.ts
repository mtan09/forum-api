// Guarded post-only scorer backfill. The default invocation is read-only.
// Usage: npm run rescore:posts
//        npm run rescore:posts -- --apply

import 'dotenv/config'
import pool, { query } from '../db'
import { POST_SCORER_VERSION, scorePost } from './score'
import { loadStoryContext, type StoryContext } from './story-context'

type PostRow = { id: string; content: string | null; position_signals: string[] | null }

/**
 * Recover the story coalition map recorded when the post was first scored.
 *
 * Re-deriving it here would silently rewrite history: cluster state changes
 * hourly, so a post scored during the Blanche confirmation would be re-judged
 * against whatever happens to be in the news on the day the rescore runs. The
 * story layer is time-stamped evidence, not a timeless rule — a rescore
 * replays it and recomputes only the parts that come from committed tables.
 */
function replayStory(signals: string[] | null): StoryContext | null {
  const raw = (signals ?? []).find((s) => s.startsWith('story:'))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw.slice('story:'.length))
    return {
      clusterKey: String(parsed.cluster ?? ''),
      storyTitle: '',
      asOf: String(parsed.asOf ?? ''),
      supports: parsed.supports ?? {},
    }
  } catch {
    return null
  }
}

async function main() {
  const apply = process.argv.includes('--apply')
  const result = await query(
    'SELECT id, content, position_signals FROM posts ORDER BY created_at, id'
  )
  const rows = result.rows as PostRow[]
  const scores: { id: string; score: ReturnType<typeof scorePost> }[] = []
  for (const post of rows) {
    // Replay a recorded judgement; derive one only where none exists. Posts
    // scored before this scorer carry no story context at all, so replay alone
    // would leave every claim about a named person permanently unresolved —
    // but re-deriving one that was already recorded would rewrite history
    // against a newer news cycle.
    const story = replayStory(post.position_signals)
      ?? await loadStoryContext(post.content ?? '')
    scores.push({ id: post.id, score: scorePost(post.content ?? '', story) })
  }
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
