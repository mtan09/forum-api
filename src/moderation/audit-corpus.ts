import 'dotenv/config'
import pool, { query } from '../db'
import { moderateText } from '../lib/moderation'

async function run() {
  const posts = await query(
    `SELECT p.id, p.user_id, p.content
     FROM posts p
     JOIN userdata u ON u.id = p.user_id
     LEFT JOIN auth_credentials a ON a.user_id = u.id
     WHERE NOT p.hidden
       AND (
         lower(COALESCE(a.email, '')) LIKE '%@example.dev'
         OR lower(COALESCE(a.email, '')) LIKE '%@forum.example'
         OR lower(u.username) IN ('john doe', 'jane smith', 'alice johnson')
       )
     ORDER BY p.created_at`
  )
  let reviewed = 0
  for (const post of posts.rows) {
    if (!post.content) continue
    const result = await moderateText(post.user_id, 'post', post.content, {
      reviewFlagged: true,
      target: { kind: 'post', id: post.id },
    })
    if (result.decision === 'review') reviewed++
  }
  console.log(`[moderation] audited ${posts.rows.length} mock posts; ${reviewed} queued for review`)
}

run()
  .catch((err) => {
    console.error('[moderation] corpus audit failed:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
