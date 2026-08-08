import 'dotenv/config'
import pool, { query } from '../src/db'
import {
  FOLLOW_REQUESTS_PATH,
  articlePath,
  debatePath,
  dmPath,
  postPath,
  userPath,
} from '../src/lib/notification-routes'
import { deliver, type NotificationKind } from '../src/lib/push'

// Walking the notification matrix by hand means waiting for someone to reply,
// upvote, DM and follow you — six events across three app states. This sends
// any one of them on demand, using the same deliver() path production uses, so
// what you tap is what a real notification would be.
//
//   npm run notify:test -- --user <id> --case new-dm
//   npm run notify:test -- --user <id> --list

type Case = {
  kind: NotificationKind
  title: string
  body: string
  /** Built from a real row when the id placeholder can be resolved. */
  path: (ids: Ids) => string
  extra?: (ids: Ids) => Record<string, unknown>
}

type Ids = {
  postId: string | null
  articleId: string | null
  debateId: string | null
  otherUserId: string | null
}

const CASES: Record<string, Case> = {
  'reply-on-post': {
    kind: 'replies',
    title: 'tester replied to your comment',
    body: 'This is a test reply notification.',
    path: (ids) => postPath(required(ids.postId, 'a post')),
  },
  'reply-on-article': {
    kind: 'replies',
    title: 'tester replied to your comment',
    body: 'This is a test reply on an article.',
    path: (ids) => articlePath(required(ids.articleId, 'an article')),
  },
  'reply-in-debate': {
    kind: 'replies',
    title: 'tester replied to your comment',
    body: 'This is a test reply in a debate.',
    path: (ids) => debatePath(required(ids.debateId, 'a debate')),
  },
  'comment-on-post': {
    kind: 'replies',
    title: 'tester commented on your post',
    body: 'This is a test comment notification.',
    path: (ids) => postPath(required(ids.postId, 'a post')),
  },
  'new-dm': {
    kind: 'dms',
    title: 'tester',
    body: 'This is a test direct message.',
    path: (ids) => dmPath(required(ids.otherUserId, 'another user')),
  },
  'post-upvoted': {
    kind: 'upvotes',
    title: 'Your post got an upvote',
    body: 'tester upvoted your post.',
    path: (ids) => postPath(required(ids.postId, 'a post')),
    extra: (ids) => ({ post_id: required(ids.postId, 'a post') }),
  },
  'follow-accepted': {
    kind: 'follows',
    title: 'Follow request accepted',
    body: 'tester accepted your follow request.',
    path: (ids) => userPath(required(ids.otherUserId, 'another user')),
  },
  'new-follower': {
    kind: 'follows',
    title: 'New follower',
    body: 'tester followed you.',
    path: (ids) => userPath(required(ids.otherUserId, 'another user')),
  },
  'follow-request': {
    kind: 'follows',
    title: 'New follow request',
    body: 'tester requested to follow you.',
    path: () => FOLLOW_REQUESTS_PATH,
  },
}

function required<T>(value: T | null, what: string): T {
  if (value == null) throw new Error(`This case needs ${what} to exist in the database.`)
  return value
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1]
  const inline = process.argv.find((entry) => entry.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : null
}

async function loadIds(userId: string): Promise<Ids> {
  const [post, article, debate, other] = await Promise.all([
    query('SELECT id FROM posts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userId]),
    query('SELECT id FROM articles ORDER BY published_at DESC NULLS LAST LIMIT 1'),
    query('SELECT id FROM debates ORDER BY debate_date DESC LIMIT 1'),
    query('SELECT id FROM userdata WHERE id <> $1 ORDER BY created_at LIMIT 1', [userId]),
  ])
  return {
    postId: post.rows[0]?.id ?? null,
    articleId: article.rows[0]?.id ?? null,
    debateId: debate.rows[0]?.id ?? null,
    otherUserId: other.rows[0]?.id ?? null,
  }
}

async function main() {
  // This writes real notifications to a real person's device. Refuse to guess
  // who that is.
  if (process.argv.includes('--list') || (!arg('user') && !arg('case'))) {
    console.log('Cases:')
    for (const [name, testCase] of Object.entries(CASES)) {
      console.log(`  ${name.padEnd(18)} ${testCase.kind}`)
    }
    console.log('\nUsage: npm run notify:test -- --user <userId> --case <case>')
    return
  }

  const userId = arg('user')
  const caseName = arg('case')
  if (!userId) throw new Error('--user <userId> is required.')
  if (!caseName) throw new Error('--case <case> is required. Use --list to see them.')

  const testCase = CASES[caseName]
  if (!testCase) throw new Error(`Unknown case "${caseName}". Use --list to see them.`)

  const user = await query('SELECT username FROM userdata WHERE id = $1', [userId])
  if (!user.rows[0]) throw new Error(`No user with id ${userId}.`)

  const tokens = await query('SELECT count(*)::int AS n FROM push_tokens WHERE user_id = $1', [
    userId,
  ])
  if (!tokens.rows[0].n) {
    console.warn(
      `! ${user.rows[0].username} has no registered push tokens — ` +
        `enable push in Settings on the device first. Sending anyway (email may still go out).`
    )
  }

  const ids = await loadIds(userId)
  const url = testCase.path(ids)

  await deliver(userId, testCase.kind, {
    title: testCase.title,
    body: testCase.body,
    data: { url, ...(testCase.extra?.(ids) ?? {}) },
  })

  console.log(
    `Sent "${caseName}" (${testCase.kind}) to ${user.rows[0].username} ` +
      `across ${tokens.rows[0].n} device(s) → ${url}`
  )
  console.log('Prefs still gate delivery; nothing arrives if the kind is switched off.')
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
