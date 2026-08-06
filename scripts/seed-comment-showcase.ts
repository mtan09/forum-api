import 'dotenv/config'
import pool from '../src/db'

const DEFAULT_POST_ID = '4aa21aff-40c8-4075-b7ca-518d24b5c800'
const postId = process.env.COMMENT_SHOWCASE_POST_ID ?? DEFAULT_POST_ID
const apply = process.env.COMMENT_SHOWCASE_APPLY === 'yes'

type Fixture = {
  jobId: string
  author: string
  parentJobId?: string
  content: string
  minutesAgo: number
  upvotes: number
  downvotes?: number
}

// A deliberately dense, substantive conversation for visually checking the
// recursive thread UI. Every author is already disclosed as a fictional demo
// account in the product, and every row remains removable with demo cleanup.
const fixtures: Fixture[] = [
  {
    jobId: 'aa100001-0000-4000-8000-000000000001',
    author: 'Maya Patel',
    content: 'The mismatch is the point. Cities can create predictable approvals when they want to. Housing should get the same published checklist and deadline—but data centers also need a real review of grid capacity and water demand.',
    minutesAgo: 185,
    upvotes: 11,
  },
  {
    jobId: 'aa100002-0000-4000-8000-000000000002',
    author: 'Tom Gallagher',
    parentJobId: 'aa100001-0000-4000-8000-000000000001',
    content: 'Exactly. The lesson is not to slow the data center down; it is to make housing rules objective enough that a compliant project can move just as quickly.',
    minutesAgo: 171,
    upvotes: 8,
  },
  {
    jobId: 'aa100003-0000-4000-8000-000000000003',
    author: 'Derek Olson',
    parentJobId: 'aa100002-0000-4000-8000-000000000002',
    content: 'That is what frustrated me. One proposal had a clear administrative path; the other kept returning to discretionary hearings. Put both standards in writing before an applicant arrives.',
    minutesAgo: 160,
    upvotes: 10,
  },
  {
    jobId: 'aa100004-0000-4000-8000-000000000004',
    author: 'Tessa Coleman',
    parentJobId: 'aa100003-0000-4000-8000-000000000003',
    content: 'Predictability helps, but approval speed alone does not guarantee homes working people can afford. Pair the faster path with mixed-income requirements or public funding instead of hoping the market reaches everyone.',
    minutesAgo: 149,
    upvotes: 7,
    downvotes: 2,
  },
  {
    jobId: 'aa100005-0000-4000-8000-000000000005',
    author: 'Kyle Brandt',
    parentJobId: 'aa100004-0000-4000-8000-000000000004',
    content: 'Requirements can also make the project stop penciling out. I would rather approve far more homes, then fund targeted rent support transparently instead of hiding the subsidy inside each building.',
    minutesAgo: 137,
    upvotes: 6,
    downvotes: 3,
  },
  {
    jobId: 'aa100006-0000-4000-8000-000000000006',
    author: 'Becky Sullivan',
    content: 'Before calling either timeline favoritism, publish what each project actually required: zoning changes, utility upgrades, traffic review, tax incentives, and public hearings. A fast approval can reflect clear rules—or a sweetheart deal.',
    minutesAgo: 166,
    upvotes: 9,
  },
  {
    jobId: 'aa100007-0000-4000-8000-000000000007',
    author: 'Victor Nguyen',
    parentJobId: 'aa100006-0000-4000-8000-000000000006',
    content: 'That comparison would settle a lot. I want median approval time by project type, the number of discretionary reviews, and how often an application is sent back. One anecdote is revealing, but the full distribution tells us whether it is systemic.',
    minutesAgo: 151,
    upvotes: 12,
  },
  {
    jobId: 'aa100008-0000-4000-8000-000000000008',
    author: 'Annie Fitzgerald',
    parentJobId: 'aa100007-0000-4000-8000-000000000007',
    content: 'Those records are often split across planning agendas, staff reports, and utility boards. A city dashboard with one timeline per application would make the comparison legible to residents and reporters.',
    minutesAgo: 140,
    upvotes: 9,
  },
  {
    jobId: 'aa100009-0000-4000-8000-000000000009',
    author: 'Dave Kowalski',
    content: 'Housing delay is a policy choice. Legalize apartments near jobs and transit, set a firm review deadline, and make code-compliant projects by-right. Two years of hearings should not be a normal cost of adding forty homes.',
    minutesAgo: 142,
    upvotes: 14,
    downvotes: 2,
  },
  {
    jobId: 'aa100010-0000-4000-8000-000000000010',
    author: 'Alice Johnson',
    parentJobId: 'aa100009-0000-4000-8000-000000000009',
    content: 'Fixed deadlines make sense, but residents still deserve a meaningful chance to raise drainage, school-capacity, or traffic concerns. The answer is a defined review window, not eliminating public input entirely.',
    minutesAgo: 129,
    upvotes: 10,
  },
  {
    jobId: 'aa100011-0000-4000-8000-000000000011',
    author: 'Omar Haddad',
    parentJobId: 'aa100010-0000-4000-8000-000000000010',
    content: 'Public input and an endless veto are different things. Notice, a hearing, written findings, and an appeal deadline protect due process without letting the rules change after an application is filed.',
    minutesAgo: 118,
    upvotes: 13,
  },
  {
    jobId: 'aa100012-0000-4000-8000-000000000012',
    author: 'Marcus Webb',
    parentJobId: 'aa100009-0000-4000-8000-000000000009',
    content: 'If the building meets the code, issue the permit. Neighbors should help write the code beforehand, not negotiate every legal project after somebody has already bought the land.',
    minutesAgo: 105,
    upvotes: 8,
    downvotes: 1,
  },
  {
    jobId: 'aa100013-0000-4000-8000-000000000013',
    author: 'Sofia Rossi',
    content: 'Housing delay eventually becomes a health issue: longer commutes, unstable rent, crowding, and people postponing care to make the month work. Local process sounds abstract until those costs arrive in an emergency room.',
    minutesAgo: 112,
    upvotes: 15,
  },
  {
    jobId: 'aa100014-0000-4000-8000-000000000014',
    author: 'Emily Chen',
    parentJobId: 'aa100013-0000-4000-8000-000000000013',
    content: 'I agree with the mechanism, but cities should measure it. Track rent burden, displacement, commute time, and avoidable emergency visits before and after permitting reforms so the policy is judged by outcomes.',
    minutesAgo: 97,
    upvotes: 11,
  },
  {
    jobId: 'aa100015-0000-4000-8000-000000000015',
    author: 'Carlos Mendoza',
    content: 'The empty lot hurts nearby businesses too. Forty households mean customers and workers; two years of uncertainty means nobody can plan. Give applicants and neighbors one calendar with real deadlines.',
    minutesAgo: 88,
    upvotes: 8,
  },
  {
    jobId: 'aa100016-0000-4000-8000-000000000016',
    author: 'Reggie Walls',
    parentJobId: 'aa100015-0000-4000-8000-000000000015',
    content: 'That is where people in my shop actually agree. They argue about height and parking, but almost nobody thinks two years of uncertainty is healthy. Set the rules, hear objections once, and decide.',
    minutesAgo: 73,
    upvotes: 9,
  },
  {
    jobId: 'aa100017-0000-4000-8000-000000000017',
    author: 'Colton Reeves',
    content: 'A data center can bring a large power load and few permanent jobs. If it gets a faster lane than housing, the city should disclose who pays for grid upgrades and whether residential customers absorb any risk.',
    minutesAgo: 64,
    upvotes: 7,
    downvotes: 1,
  },
  {
    jobId: 'aa100018-0000-4000-8000-000000000018',
    author: 'Ingrid Larsen',
    parentJobId: 'aa100017-0000-4000-8000-000000000017',
    content: 'And compare benefits consistently: tax revenue, infrastructure cost, construction jobs, permanent jobs, and land consumed. The city may still approve both, but the tradeoff should not be buried in two different processes.',
    minutesAgo: 51,
    upvotes: 10,
  },
  {
    jobId: 'aa100019-0000-4000-8000-000000000019',
    author: 'Rachel Steinberg',
    content: 'This would make a useful civics exercise: ask students to map every decision point for each project and identify which ones are required by law versus custom. Process becomes political power when only specialists can follow it.',
    minutesAgo: 39,
    upvotes: 12,
  },
  {
    jobId: 'aa100020-0000-4000-8000-000000000020',
    author: 'Nia Brooks',
    parentJobId: 'aa100019-0000-4000-8000-000000000019',
    content: 'That framing also avoids pretending every delay is corrupt. Some reviews protect the public; others survive because nobody owns the deadline. Mapping the process lets people argue about the actual bottleneck.',
    minutesAgo: 24,
    upvotes: 9,
  },
]

async function main() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('forum-comment-showcase'))")

    const target = await client.query(
      `SELECT p.id, p.content, p.commentcount, u.username, u.is_demo
       FROM posts p JOIN userdata u ON u.id = p.user_id
       WHERE p.id = $1 AND NOT p.hidden
       FOR UPDATE OF p`,
      [postId]
    )
    if (!target.rows[0]) throw new Error(`Showcase post ${postId} is unavailable.`)
    if (!target.rows[0].is_demo) throw new Error('The showcase may only target a fictional demo post.')

    const requestedAuthors = [...new Set(fixtures.map((fixture) => fixture.author))]
    const accounts = await client.query(
      `SELECT id, username FROM userdata
       WHERE is_demo = TRUE AND username = ANY($1::text[])`,
      [requestedAuthors]
    )
    const userIdByName = new Map(accounts.rows.map((row) => [String(row.username), String(row.id)]))
    const missing = requestedAuthors.filter((username) => !userIdByName.has(username))
    if (missing.length > 0) throw new Error(`Missing demo authors: ${missing.join(', ')}`)

    const summary = {
      apply,
      post_id: postId,
      post_author: target.rows[0].username,
      post_preview: String(target.rows[0].content).slice(0, 120),
      fixture_comments: fixtures.length,
      top_level_comments: fixtures.filter((fixture) => !fixture.parentJobId).length,
      deepest_level: 4,
    }
    if (!apply) {
      await client.query('ROLLBACK')
      console.log(JSON.stringify(summary, null, 2))
      console.log('Dry run only. Set COMMENT_SHOWCASE_APPLY=yes to populate the thread.')
      return
    }

    const idByJob = new Map<string, string>()
    for (const fixture of fixtures) {
      const parentId = fixture.parentJobId ? idByJob.get(fixture.parentJobId) : null
      if (fixture.parentJobId && !parentId) throw new Error(`Missing parent fixture ${fixture.parentJobId}`)
      const inserted = await client.query(
        `INSERT INTO comments
           (user_id, post_id, parent_comment_id, content, is_demo_generated, demo_job_id, created_at)
         VALUES ($1, $2, $3, $4, TRUE, $5, NOW() - make_interval(mins => $6))
         ON CONFLICT (demo_job_id) WHERE demo_job_id IS NOT NULL DO UPDATE SET
           user_id = EXCLUDED.user_id,
           post_id = EXCLUDED.post_id,
           parent_comment_id = EXCLUDED.parent_comment_id,
           content = EXCLUDED.content,
           is_demo_generated = TRUE
         RETURNING id`,
        [
          userIdByName.get(fixture.author),
          postId,
          parentId,
          fixture.content,
          fixture.jobId,
          fixture.minutesAgo,
        ]
      )
      idByJob.set(fixture.jobId, String(inserted.rows[0].id))
    }

    const voters = accounts.rows.map((row) => ({ id: String(row.id), username: String(row.username) }))
    for (const fixture of fixtures) {
      const commentId = idByJob.get(fixture.jobId)!
      const eligible = voters.filter((voter) => voter.username !== fixture.author)
      const upvoters = eligible.slice(0, fixture.upvotes)
      const downvoters = eligible.slice(fixture.upvotes, fixture.upvotes + (fixture.downvotes ?? 0))
      for (const voter of upvoters) {
        await client.query(
          `INSERT INTO comment_votes (user_id, comment_id, direction)
           VALUES ($1, $2, 'up')
           ON CONFLICT (user_id, comment_id) DO UPDATE SET direction = 'up'`,
          [voter.id, commentId]
        )
      }
      for (const voter of downvoters) {
        await client.query(
          `INSERT INTO comment_votes (user_id, comment_id, direction)
           VALUES ($1, $2, 'down')
           ON CONFLICT (user_id, comment_id) DO UPDATE SET direction = 'down'`,
          [voter.id, commentId]
        )
      }
      await client.query(
        `UPDATE comments SET
           upvotes = (SELECT count(*) FROM comment_votes WHERE comment_id = $1 AND direction = 'up'),
           downvotes = (SELECT count(*) FROM comment_votes WHERE comment_id = $1 AND direction = 'down')
         WHERE id = $1`,
        [commentId]
      )
    }

    const updated = await client.query(
      `UPDATE posts SET commentcount = (
         SELECT count(*) FROM comments WHERE post_id = $1
       ) WHERE id = $1 RETURNING commentcount`,
      [postId]
    )
    await client.query('COMMIT')
    console.log(JSON.stringify({ ...summary, comment_count: updated.rows[0].commentcount }, null, 2))
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
