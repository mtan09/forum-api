// Idempotently add the balanced stance-scoring fixture through the real API.
// Existing mock users are resolved from the dev database, then issued normal
// short-lived app tokens; passwords and production rate limits are untouched.
// Usage: npm run seed:stances (server must be running)

import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pool, { query } from '../db'
import { issueToken } from '../lib/auth'

type Fixture = {
  username: string
  hashtags: string[]
  expected: [number, number]
  content: string
}

type StoredPost = {
  id: string
  content: string
  position: number | null
}

const API = process.env.API_URL || 'http://localhost:3000'
const fixtures = JSON.parse(
  readFileSync(resolve(process.cwd(), 'scripts/stance-posts.json'), 'utf8')
) as Fixture[]

function validate(post: StoredPost, fixture: Fixture) {
  const [min, max] = fixture.expected
  const position = post.position == null ? null : Number(post.position)
  if (position == null || position < min || position > max) {
    throw new Error(
      `Stance outside expected range ${min}–${max}: ${position ?? 'unclassified'} — ${fixture.content}`
    )
  }
}

async function main() {
  const { rows } = await query(
    'SELECT id, content, position FROM posts WHERE content = ANY($1::text[])',
    [fixtures.map((fixture) => fixture.content)]
  )
  const existing = new Map(
    (rows as StoredPost[]).map((post) => [post.content, post])
  )

  let created = 0
  for (const fixture of fixtures) {
    let post = existing.get(fixture.content)
    if (!post) {
      const userResult = await query(
        'SELECT id FROM userdata WHERE username = $1',
        [fixture.username]
      )
      const userId = userResult.rows[0]?.id as string | undefined
      if (!userId) {
        throw new Error(`Missing mock user ${fixture.username}; run the community seed first.`)
      }

      const token = await issueToken(userId)
      const response = await fetch(`${API}/posts`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: fixture.content, hashtags: fixture.hashtags }),
      })
      const body = await response.json().catch(() => null) as StoredPost | { error?: string } | null
      if (!response.ok) {
        throw new Error(`/posts → ${response.status}: ${body && 'error' in body ? body.error : 'unknown'}`)
      }
      post = body as StoredPost
      created++
    }
    validate(post, fixture)
  }

  console.log(`[seed:stances] ${fixtures.length} validated — ${created} created, ${fixtures.length - created} existing`)
}

main()
  .catch((err) => {
    console.error('[seed:stances] fatal:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
