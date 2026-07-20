// Populates the dev community: users with real portrait avatars, varied
// posts (partisan and neutral), threaded comments, and votes — all via
// the real API so everything is scored/validated like production traffic.
// Idempotent: existing users are logged into instead of recreated, and
// posts are skipped if their text already exists.
//
// Usage: node scripts/seed-community.mjs   (server must be running)

const API = process.env.API_URL || 'http://localhost:3000'

const USERS = [
  // avatar portraits from randomuser.me (stable, hotlinkable)
  { username: 'John Doe',        email: 'john@example.dev',    avatar: 'https://randomuser.me/api/portraits/men/32.jpg' },
  { username: 'Jane Smith',      email: 'jane@example.dev',    avatar: 'https://randomuser.me/api/portraits/women/44.jpg' },
  { username: 'Alice Johnson',   email: 'alice@example.dev',   avatar: 'https://randomuser.me/api/portraits/women/68.jpg' },
  { username: 'Marcus Webb',     email: 'marcus@example.dev',  avatar: 'https://randomuser.me/api/portraits/men/75.jpg' },
  { username: 'Priya Raman',     email: 'priya@example.dev',   avatar: 'https://randomuser.me/api/portraits/women/21.jpg' },
  { username: 'Dave Kowalski',   email: 'dave@example.dev',    avatar: 'https://randomuser.me/api/portraits/men/11.jpg' },
  { username: 'Elena Vasquez',   email: 'elena@example.dev',   avatar: 'https://randomuser.me/api/portraits/women/57.jpg' },
  { username: 'Tom Gallagher',   email: 'tom@example.dev',     avatar: 'https://randomuser.me/api/portraits/men/29.jpg' },
  { username: 'Nia Brooks',      email: 'nia@example.dev',     avatar: 'https://randomuser.me/api/portraits/women/12.jpg' },
  { username: 'Sam Whitfield',   email: 'sam@example.dev',     avatar: 'https://randomuser.me/api/portraits/men/52.jpg' },
  { username: 'Grace Lindqvist', email: 'grace@example.dev',   avatar: 'https://randomuser.me/api/portraits/women/33.jpg' },
]
const PASSWORD = 'password123'

// user = index into USERS. Mix of partisan and neutral voices.
const POSTS = [
  { user: 3, hashtags: ['border', 'immigration'],
    content: 'The border crisis is real and getting worse. Illegal aliens crossing daily while politicians debate. We need law and order, not open borders talk.' },
  { user: 4, hashtags: ['climate', 'energy'],
    content: 'The climate crisis will not wait for another election cycle. Big oil keeps blocking progress while communities flood. Climate justice is economic justice.' },
  { user: 5, hashtags: ['economy', 'inflation'],
    content: 'Grocery prices are still up 20% from three years ago. Both parties talk about inflation but neither has a real plan for housing costs.' },
  { user: 6, hashtags: ['guncontrol', 'rights'],
    content: 'Another school lockdown in my county this week. Gun safety legislation keeps dying in committee while the gun lobby writes the talking points.' },
  { user: 7, hashtags: ['taxes', 'economy'],
    content: 'Tax relief for job creators is how you grow an economy. The death tax and capital gains hikes punish the small businesses that hire people.' },
  { user: 8, hashtags: ['healthcare'],
    content: 'Spent four hours on the phone fighting an insurance denial for my mom. Whatever your politics, the American healthcare billing system is broken.' },
  { user: 9, hashtags: ['freespeech', 'tech'],
    content: 'Cancel culture is out of control on campus. Woke administrators police every word while claiming to defend free speech. Parental rights matter in education too.' },
  { user: 10, hashtags: ['voting', 'elections'],
    content: 'Voting rights should not depend on your zip code. Voter suppression through closed polling places is quieter than the loud fraud claims, but far more real.' },
  { user: 3, hashtags: ['china', 'trade'],
    content: 'Tariffs on China are one thing both administrations quietly agreed on. Curious what people here think — did they bring any manufacturing back?' },
  { user: 5, hashtags: ['ai', 'tech'],
    content: 'AI regulation talk is all vibes right now. The EU model is compliance-heavy, the US model is vibes-only. Neither seems built for what ships next year.' },
  { user: 6, hashtags: ['housing'],
    content: 'Rent ate 45% of my paycheck this month. Zoning reform gets bipartisan lip service and zero votes. Housing is the issue politics keeps ignoring.' },
  { user: 8, hashtags: ['media'],
    content: 'Challenge: read one article today from an outlet you distrust. Not to agree — just to see what their readers see. This app makes it easy.' },
  // --- wave 2 ---
  { user: 0, hashtags: ['elections', 'voterid'],
    content: 'Voter ID polls well until you ask who pays for the free IDs and DMV hours in rural counties. Details are where this debate actually lives.' },
  { user: 1, hashtags: ['defense', 'ukraine'],
    content: 'Defense spending debates never mention that half the budget is personnel and maintenance. The shiny weapons are the small part.' },
  { user: 2, hashtags: ['studentloans'],
    content: 'Student loan forgiveness is a regressive giveaway to future high earners. Fix the interest capitalization racket instead — that part everyone should agree on.' },
  { user: 4, hashtags: ['abortion', 'rights'],
    content: 'Reproductive rights are on state ballots again this fall. Every single time voters decide directly, bodily autonomy wins — even in deep red states.' },
  { user: 7, hashtags: ['crime', 'police'],
    content: 'Violent crime is down in most cities but nobody believes it because local news is a 24/7 crime reel. Perception is running the policy conversation.' },
  { user: 3, hashtags: ['energy', 'nuclear'],
    content: 'Energy independence means drilling AND nuclear. The radical left blocks both and then wonders why rates spike every summer.' },
  { user: 9, hashtags: ['schoolchoice', 'education'],
    content: 'School choice keeps winning enrollment numbers while district schools lose them. Parents are voting with their feet — maybe listen to them.' },
  { user: 10, hashtags: ['unions', 'labor'],
    content: 'Union elections at the big warehouses keep failing by tiny margins under massive pressure campaigns. A living wage should not require a heroic organizing effort.' },
  { user: 5, hashtags: ['socialsecurity'],
    content: 'Social Security hits the trust fund cliff in about six years and both parties treat mentioning it as career suicide. The math does not care about the politics.' },
  { user: 6, hashtags: ['immigration', 'daca'],
    content: 'DACA recipients have been in legal limbo for over a decade. Whatever you think about the border, people brought here as toddlers are a different question.' },
  { user: 8, hashtags: ['courts', 'scotus'],
    content: 'Supreme Court term limits poll at 65%+ across parties and go nowhere. Genuine question: what reform proposal do people here actually think is workable?' },
  { user: 1, hashtags: ['china', 'taiwan'],
    content: 'Taiwan semiconductor dependence is the single biggest strategic vulnerability nobody votes on. The chips are the whole game.' },
  { user: 10, hashtags: ['minimumwage'],
    content: 'Seattle has had a $15+ minimum wage for years. Restaurants did not vanish. At some point the doom predictions need to answer to the data.' },
  { user: 7, hashtags: ['spending', 'debt'],
    content: 'The interest on the national debt now costs more than the entire defense budget. Big government spending has real bills, and they are arriving.' },
]

// [postIndex, userIndex, content] — top-level comments
const COMMENTS = [
  [0, 4, 'Border apprehension numbers are actually down year over year — the data matters more than the vibes here.'],
  [0, 7, 'Agreed on enforcement. The asylum backlog is the real bottleneck though, and neither party funds the courts.'],
  [1, 3, 'Every climate bill doubles as a spending wishlist. Nuclear is the serious answer and it barely gets mentioned.'],
  [1, 8, 'The flood insurance market collapsing in Florida is making this real for people who never used the word climate.'],
  [2, 6, 'Housing is 40% of CPI and nobody campaigns on it. Wild.'],
  [2, 3, 'Energy costs drive everything downstream. Drill more, prices fall. It is not complicated.'],
  [3, 9, 'Law-abiding gun owners are not the problem. Enforce the hundred laws already on the books first.'],
  [3, 10, 'Background check polling is at like 85% support. The gap between voters and votes on this is the whole story.'],
  [4, 5, 'Small business owner here. The paperwork burden is worse than the tax rate, honestly.'],
  [5, 4, 'The billing codes thing is universal. Single payer or not, the administrative layer is pure waste.'],
  [6, 10, 'Universities are contract institutions — if they promise open inquiry they should deliver it, left or right speaker alike.'],
  [7, 3, 'Every legal vote should count and be easy to cast AND verify. Both halves of that sentence matter.'],
  [8, 5, 'Reshoring numbers say a little, at high cost per job. The chips act did more than the tariffs did.'],
  [9, 8, 'The vibes-only description is painfully accurate. Nobody writing these bills has ever deployed a model.'],
  [10, 4, 'YIMBY left and deregulation right agree on this one and it still never passes. Incumbent homeowners vote.'],
  // --- wave 2 (post indices 12+) ---
  [12, 7, 'The free ID provision was in three failed bills. Both sides prefer the fight to the fix.'],
  [12, 4, 'Rural DMV closures hit Republican voters hardest, which is the quiet irony of this whole debate.'],
  [13, 3, 'Personnel costs are untouchable politically, so every "cut waste" plan is really a readiness cut in disguise.'],
  [14, 10, 'The interest capitalization point is right. Balances growing while you pay on time radicalized more people than any activist did.'],
  [14, 0, 'Forgiveness without fixing the pipeline just resets the clock for the next generation of borrowers.'],
  [15, 9, 'State ballots are exactly where this belongs. Let voters decide, not judges.'],
  [15, 6, 'The ballot results and the legislature votes in the same states tell two totally different stories. Gerrymandering explains the gap.'],
  [16, 8, 'Local crime coverage runs on cheap police blotter content. The incentive structure is the story.'],
  [17, 4, 'Nuclear yes, but "drill more" while aquifers dry up is not independence, it is borrowing from the future.'],
  [18, 10, 'Public schools take every kid — including the ones vouchers quietly leave behind. Compare like with like.'],
  [18, 3, 'Enrollment numbers are the only poll that matters here. Families are not confused about their own kids.'],
  [19, 5, 'The margin stories undersell how one-sided the information environment is inside those warehouses.'],
  [20, 7, 'Raise the cap, raise the age, or cut benefits. Pick two. Everything else is arithmetic denial.'],
  [21, 0, 'A decade of limbo is the point — permanent uncertainty is cheaper politically than any actual decision.'],
  [22, 1, '18-year staggered terms with each president getting two picks is the only version that does not blow up confirmation wars.'],
  [23, 5, 'The Arizona fabs are years behind schedule. Reshoring chips is a decade project being sold as a press release.'],
  [24, 7, 'Seattle also has Amazon-tier wages pulling everything up. Try that experiment in a rural county and report back.'],
  [25, 4, 'The debt interest number is real — worth asking which party added more of it before wearing the fiscal hawk costume.'],
]

// [commentIndex, userIndex, content] — replies to the comments above
const REPLIES = [
  [0, 3, 'Down from a record peak is still historically high. Both things are true.'],
  [1, 0, 'The court funding point never gets airtime. Good catch.'],
  [2, 4, 'No argument on nuclear from me. Permitting reform would help there too.'],
  [6, 6, 'Enforcement AND new law are not mutually exclusive though.'],
  [7, 9, 'Polling support collapses when specific bill text shows up. That gap is also part of the story.'],
  [11, 10, 'This is the most reasonable take in the thread.'],
  // --- wave 2 (comment indices 15+) ---
  [15, 0, 'Which bills? Genuinely asking — would like to read the provisions.'],
  [17, 1, 'Same dynamic as base closures. Everyone wants cuts in someone else’s district.'],
  [20, 4, 'The legislature/ballot gap deserves way more attention than it gets.'],
  [24, 9, 'And the kids vouchers "leave behind" are stuck in schools that failed them first. That cuts both ways.'],
  [27, 10, 'Pick two is generous. Realistically we do all three a little bit, late, in a crisis.'],
  [29, 8, 'The staggered terms version also passed a Senate committee once. It is not even fringe.'],
  [31, 3, 'Rural counties also have rural rents. The comparison is never apples to apples in either direction.'],
]

// A few comments on news articles so article threads aren't empty:
// { articleOffset } = index into the newest /articles list
const ARTICLE_COMMENTS = [
  { articleOffset: 0, user: 5, content: 'Worth reading past the headline on this one — the details are messier than the framing.' },
  { articleOffset: 0, user: 9, content: 'Notice which quotes they led with. Same story reads completely differently elsewhere.' },
  { articleOffset: 1, user: 2, content: 'Been following this story all week. This is the most thorough piece on it so far.' },
  { articleOffset: 2, user: 7, content: 'The numbers buried in paragraph nine are the actual story here.' },
  { articleOffset: 3, user: 4, content: 'Compare this coverage with how the other side of the spectrum wrote it up. Instructive.' },
]

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: body && method === 'GET' ? 'POST' : method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${data?.error ?? 'unknown'}`)
  return data
}

async function main() {
  // 1. Users: login or signup, then set avatar
  const tokens = []
  for (const u of USERS) {
    let auth
    try {
      auth = await call('/auth/login', { body: { email: u.email, password: PASSWORD } })
    } catch {
      auth = await call('/auth/signup', { body: { username: u.username, email: u.email, password: PASSWORD } })
      console.log(`created user ${u.username}`)
    }
    tokens.push(auth.token)
    await call('/users/me', { method: 'PATCH', token: auth.token, body: { avatar_url: u.avatar } })
  }
  console.log(`${USERS.length} users ready, avatars set`)

  // 2. Posts (skip ones that already exist)
  const existing = await call('/posts?limit=100', { token: tokens[0] })
  const have = new Set(existing.map((p) => p.content))
  const postIds = []
  for (const p of POSTS) {
    const found = existing.find((e) => e.content === p.content)
    if (found) {
      postIds.push(found.id)
      continue
    }
    const created = await call('/posts', {
      token: tokens[p.user],
      body: { content: p.content, hashtags: p.hashtags },
    })
    postIds.push(created.id)
  }
  console.log(`${postIds.length} posts ready (${postIds.length - [...have].filter(h => POSTS.some(p => p.content === h)).length} new)`)

  // 3. Comments + replies (skip if the post already has comments)
  const commentIds = []
  for (let i = 0; i < COMMENTS.length; i++) {
    const [post, user, content] = COMMENTS[i]
    const page = await call(`/comments?post_id=${postIds[post]}&limit=50`, { token: tokens[0] })
    const found = page.comments.find((cm) => cm.content === content)
    if (found) {
      commentIds.push(found.id)
      continue
    }
    const created = await call('/comments', { token: tokens[user], body: { post_id: postIds[post], content } })
    commentIds.push(created.id)
  }
  for (const [commentIdx, user, content] of REPLIES) {
    const page = await call(`/comments?parent_comment_id=${commentIds[commentIdx]}&limit=50`, { token: tokens[0] })
    if (page.comments.some((cm) => cm.content === content)) continue
    await call('/comments', { token: tokens[user], body: { parent_comment_id: commentIds[commentIdx], content } })
  }
  console.log(`${COMMENTS.length} comments + ${REPLIES.length} replies ready`)

  // 3b. Comments on the newest articles
  const articles = await call('/articles?limit=10', { token: tokens[0] })
  for (const ac of ARTICLE_COMMENTS) {
    const article = articles[ac.articleOffset]
    if (!article) continue
    const page = await call(`/comments?article_id=${article.id}&limit=50`, { token: tokens[0] })
    if (page.comments.some((cm) => cm.content === ac.content)) continue
    await call('/comments', { token: tokens[ac.user], body: { article_id: article.id, content: ac.content } })
  }
  console.log(`${ARTICLE_COMMENTS.length} article comments ready`)

  // 4. Votes — deterministic spread so counts look lived-in
  for (let p = 0; p < postIds.length; p++) {
    const voters = 3 + (p % 4)
    for (let v = 0; v < voters; v++) {
      const voter = (p + v * 3 + 1) % USERS.length
      const direction = (p + v) % 4 === 0 ? 'down' : 'up'
      await call(`/posts/${postIds[p]}/vote`, { token: tokens[voter], body: { direction } })
    }
  }
  for (let ci = 0; ci < commentIds.length; ci++) {
    const voters = 1 + (ci % 3)
    for (let v = 0; v < voters; v++) {
      const voter = (ci + v * 2 + 2) % USERS.length
      const direction = (ci + v) % 5 === 0 ? 'down' : 'up'
      await call(`/comments/${commentIds[ci]}/vote`, { token: tokens[voter], body: { direction } })
    }
  }
  console.log('votes cast on posts and comments')
  console.log('Community seed complete.')
}

main().catch((err) => {
  console.error('Seed failed:', err.message)
  process.exit(1)
})
