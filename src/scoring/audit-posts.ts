// Read-only scorer audit over the current post pool.
// Usage: npm run audit:posts

import 'dotenv/config'
import pool, { query } from '../db'
import { scorePost } from './score'

type PostRow = {
  username: string
  content: string
  position: number | null
}

const side = (position: number | null) => {
  if (position == null) return 'unclassified'
  if (position < 0.45) return 'left'
  if (position > 0.55) return 'right'
  return 'center'
}

async function main() {
  const { rows } = await query(
    `SELECT u.username, p.content, p.position
     FROM posts p JOIN userdata u ON u.id = p.user_id
     WHERE NOT p.hidden
     ORDER BY p.created_at DESC`
  )

  const posts = rows as PostRow[]
  const counts = { left: 0, center: 0, right: 0, unclassified: 0 }
  const results = posts.map((post) => {
    const score = scorePost(post.content)
    const band = side(score.position)
    counts[band]++
    return {
      author: post.username,
      current: post.position == null ? '—' : Number(post.position).toFixed(3),
      proposed: score.position == null ? '—' : score.position.toFixed(3),
      band,
      confidence: score.confidence.toFixed(2),
      evidence: score.signals
        .filter((signal) => /^(stance-|left:|right:)/.test(signal))
        .join('; '),
      post: post.content.length > 92 ? `${post.content.slice(0, 89)}…` : post.content,
    }
  })

  console.log(`Scorer audit: ${posts.length} posts`)
  console.log(counts)
  console.table(results)
}

main()
  .catch((err) => {
    console.error('[audit:posts] fatal:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
