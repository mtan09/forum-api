#!/usr/bin/env node
// Seeds dev users/posts/comments/votes through the real API.
// Users and post shapes come from the app's original data/mockPosts.ts.
// Safe to re-run: existing users are logged in instead of recreated,
// and posts are skipped if that user already has posts.

const API = process.env.API_URL ?? 'http://localhost:3000'

const TOPICS = {
  elections: '8c4a1a64-d3b6-4eb2-b86c-d9af397cdb1e',
  foreign: 'b2341048-0108-450d-91ae-d0f509f6f574',
  economy: 'f289ef45-488d-46cf-aad2-d045453f4875',
  tech: '49abf187-8b6b-419d-a093-a76dc7104819',
  immigration: 'd2cfb810-94f0-4446-982c-38ad27585bca',
  health: '2e6042ef-4598-42a8-8624-1eb961845cbd',
  rights: '95f37b29-a5f9-432b-a411-b5ba1e16a493',
}

const USERS = [
  { username: 'John Doe', email: 'john@example.dev', password: 'password123' },
  { username: 'Jane Smith', email: 'jane@example.dev', password: 'password123' },
  { username: 'Alice Johnson', email: 'alice@example.dev', password: 'password123' },
]

// Adapted from mockPosts.ts — same authors/positions, on-topic text
const POSTS = [
  { user: 0, topic: TOPICS.elections, position: 0.3,
    content: 'The new redistricting ruling is a big deal. Whatever your politics, maps drawn by independent commissions poll better with voters in both parties.' },
  { user: 1, topic: TOPICS.foreign, position: 0.35,
    content: 'Defense budget season again. Modernization vs readiness is a real tradeoff — you cannot fund next-gen drones by deferring maintenance forever.' },
  { user: 2, topic: TOPICS.tech, position: 0.6,
    content: 'Hot take: the AI transparency requirements in the new bill are lighter than what most serious labs already do voluntarily. Compliance cost worries feel overstated.' },
  { user: 0, topic: TOPICS.economy, position: 0.5,
    content: 'Fed held rates again. Sticky services inflation is the whole story — goods prices normalized a year ago.' },
  { user: 1, topic: TOPICS.health, position: 0.9,
    content: 'Grid interconnection queues are the quiet bottleneck of the energy transition. Five-year waits for approved projects is a policy failure, not an engineering one.' },
  // Two clearly partisan posts so the scored-spectrum display is visible
  // in dev (the neutral posts above correctly gate to no placement)
  { user: 2, topic: TOPICS.rights, position: 0.1,
    content: 'We need commonsense gun reform now. The gun lobby keeps blocking gun safety laws while assault weapons stay on our streets. Voting rights and racial justice are on the ballot too.' },
  { user: 0, topic: TOPICS.immigration, position: 0.9,
    content: 'Open borders policies created this border crisis. Illegal aliens are straining services while the radical left pushes handouts. Election integrity and law and order matter.' },
]

const COMMENTS = [
  { post: 0, user: 1, content: 'Independent commissions have their own problems, but agreed the status quo is worse.' },
  { post: 0, user: 2, content: 'The appeal timeline is what matters here — maps may not change before the primary.' },
  { post: 2, user: 0, content: 'The cost falls on startups without compliance teams though, not the big labs.' },
]

async function req(path, { token, body, method } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, data }
}

const health = await req('/health')
if (!health.ok) {
  console.error(`API not reachable at ${API} — start it with: npm run dev`)
  process.exit(1)
}

// 1. Sign up (or log in) the mock users
const tokens = []
for (const u of USERS) {
  let r = await req('/auth/signup', { body: u })
  if (r.status === 409) r = await req('/auth/login', { body: { email: u.email, password: u.password } })
  if (!r.ok) {
    console.error(`Failed to create/login ${u.username}:`, r.data)
    process.exit(1)
  }
  tokens.push(r.data.token)
  console.log(`✓ user ${u.username}`)
}

// 2. Posts (skip if seed posts already exist)
const existing = await req('/posts?limit=100', { token: tokens[0] })
const alreadySeeded = existing.data?.some?.((p) => p.content === POSTS[0].content)
const postIds = []
if (alreadySeeded) {
  console.log('✓ posts already seeded — skipping')
} else {
  for (const p of POSTS) {
    const r = await req('/posts', {
      token: tokens[p.user],
      body: { content: p.content, general_topic_id: p.topic, position: p.position },
    })
    if (!r.ok) {
      console.error('Failed to create post:', r.data)
      process.exit(1)
    }
    postIds.push(r.data.id)
    console.log(`✓ post by ${USERS[p.user].username}`)
  }

  // 3. Comments
  for (const c of COMMENTS) {
    const r = await req('/comments', {
      token: tokens[c.user],
      body: { post_id: postIds[c.post], content: c.content },
    })
    console.log(r.ok ? `✓ comment by ${USERS[c.user].username}` : `✗ comment failed: ${JSON.stringify(r.data)}`)
  }

  // 4. Cross-votes so the feed isn't all zeros
  const votes = [
    [0, 1, 'up'], [0, 2, 'up'], [1, 0, 'up'], [2, 0, 'down'], [3, 2, 'up'], [4, 0, 'up'], [4, 2, 'up'],
  ]
  for (const [post, user, direction] of votes) {
    if (postIds[post]) {
      await req(`/posts/${postIds[post]}/vote`, { token: tokens[user], body: { direction } })
    }
  }
  console.log('✓ votes')
}

console.log('\nDone. Log in as e.g. john@example.dev / password123')
