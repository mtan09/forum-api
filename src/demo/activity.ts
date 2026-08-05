import pool, { query } from '../db'
import { ensureTodaysDebates } from '../routes/debates'
import { matchTopic } from '../ingest/topics'
import { semanticEmbedding } from '../recommendation/semantic'
import { scorePost } from '../scoring/score'
import { captureException } from '../lib/sentry'
import { demoBio, DEMO_PERSONAS, type DemoPersona } from './personas'
import { generateDemoComment, generateDemoPost } from './generate'

export type DemoActivityKind =
  | 'post'
  | 'post_comment'
  | 'post_vote'
  | 'article_comment'
  | 'article_vote'
  | 'debate_comment'
  | 'debate_vote'
  | 'comment_vote'

type PersonaRow = DemoPersona & { userId: string }
type ActivityJob = {
  id: string
  user_id: string
  kind: DemoActivityKind
  target_id: string | null
  payload: Record<string, unknown>
  attempts: number
}

function hashUnit(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 4294967296
}

export function demoVoteDirection(personaLean: number, targetLean: number | null, salt: string): 'up' | 'down' {
  if (targetLean == null) return hashUnit(salt) < 0.78 ? 'up' : 'down'
  const distance = Math.abs(personaLean - targetLean)
  const aligned = distance <= 0.34
  const contrarian = hashUnit(`${salt}:contrarian`) < 0.13
  return aligned !== contrarian ? 'up' : 'down'
}

export function scheduledOffsetMinutes(key: string): number {
  // Five minutes to twelve hours: frequent enough for a short review window,
  // but not a synchronized burst that looks like a seed script ran.
  return 5 + Math.floor(hashUnit(key) * 715)
}

export function articleEngagementOffsetMinutes(key: string): number {
  // Incoming coverage should gain visible community activity during the same
  // review session, without every fictional account reacting in one burst.
  return 5 + Math.floor(hashUnit(key) * 101)
}

export function demoArticleVoterCount(articleId: string, availablePersonas: number): number {
  if (availablePersonas <= 0) return 0
  return Math.min(availablePersonas, 2 + Math.floor(hashUnit(`${articleId}:voters`) * 4))
}

export function demoArticleShouldReceiveComment(articleId: string, clustered: boolean): boolean {
  // Clustered coverage is more likely to be important enough for a thread.
  // Unclustered cards still occasionally receive a reaction, but comments do
  // not become uniform or create an unbounded generation bill.
  return hashUnit(`${articleId}:comment`) < (clustered ? 0.20 : 0.08)
}

export function demoPersonaPostsOnDay(index: number, ordinal: number): boolean {
  // Each persona writes on two days of every three-day rotation: roughly
  // 20-21 concise posts daily across the 31-account review community.
  return (index + ordinal) % 3 !== 2
}

export type DemoPerspective = 'left' | 'center' | 'right'

export function demoPerspective(lean: number): DemoPerspective {
  if (lean < 0.42) return 'left'
  if (lean > 0.58) return 'right'
  return 'center'
}

// Persona lean is a generation-quality expectation only. The score still
// comes exclusively from the final post text through scorePost().
export function demoScoreMatchesPersona(lean: number, position: number | null): boolean {
  const expected = demoPerspective(lean)
  if (expected === 'center') return true
  if (position == null) return false
  return expected === 'left' ? position < 0.46 : position > 0.54
}

function appDay(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function dayNumber(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  return Math.floor(Date.UTC(year, month - 1, date) / 86_400_000)
}

async function syncPersonas(): Promise<PersonaRow[]> {
  const rows = await query(
    `SELECT id, username
     FROM userdata
     WHERE is_demo = TRUE AND username = ANY($1::text[])`,
    [DEMO_PERSONAS.map((persona) => persona.username)]
  )
  const byName = new Map(rows.rows.map((row) => [String(row.username), String(row.id)]))
  const matched: PersonaRow[] = []
  for (const persona of DEMO_PERSONAS) {
    const userId = byName.get(persona.username)
    if (!userId) continue
    await query(
      `INSERT INTO demo_personas (user_id, lean, role, voice, interests, cadence_seed, active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       ON CONFLICT (user_id) DO UPDATE SET
         lean = EXCLUDED.lean,
         role = EXCLUDED.role,
         voice = EXCLUDED.voice,
         interests = EXCLUDED.interests,
         cadence_seed = EXCLUDED.cadence_seed,
         active = TRUE,
         updated_at = NOW()`,
      [userId, persona.lean, persona.role, persona.voice, persona.interests, persona.cadenceSeed]
    )
    await query(
      `UPDATE userdata
       SET bio = $2, avatar_url = NULL, header_url = NULL
       WHERE id = $1 AND is_demo = TRUE`,
      [userId, demoBio(persona)]
    )
    matched.push({ ...persona, userId })
  }
  return matched
}

async function insertJob(input: {
  day: string
  userId: string
  kind: DemoActivityKind
  targetId?: string
  payload?: Record<string, unknown>
  suffix: string
  dedupeKey?: string
  offsetMinutes?: number
  runQuery?: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>
}): Promise<boolean> {
  const dedupeKey = input.dedupeKey ?? `${input.day}:${input.kind}:${input.userId}:${input.suffix}`
  const scheduledFor = new Date(
    Date.now() + (input.offsetMinutes ?? scheduledOffsetMinutes(dedupeKey)) * 60_000
  )
  const result = await (input.runQuery ?? query)(
    `INSERT INTO demo_activity_jobs
       (user_id, kind, target_id, payload, scheduled_for, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [input.userId, input.kind, input.targetId ?? null, input.payload ?? {}, scheduledFor, dedupeKey]
  )
  return result.rows.length > 0
}

function articleAffinity(
  persona: PersonaRow,
  article: { id: string; title: string; source: string; topic: string }
): number {
  const haystack = `${article.title} ${article.source} ${article.topic}`.toLowerCase()
  const interestMatches = persona.interests.filter((interest) => {
    const terms = interest.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 4)
    return terms.some((term) => haystack.includes(term))
  }).length
  return hashUnit(`${article.id}:${persona.cadenceSeed}:affinity`) + Math.min(interestMatches, 2) * 0.7
}

async function planDailyActivity(personas: PersonaRow[]): Promise<number> {
  if (personas.length === 0) return 0
  const day = appDay()
  const ordinal = dayNumber(day)
  let planned = 0

  // Every persona authors two concise posts during each three-day rotation.
  const posters = personas.filter((_, index) => demoPersonaPostsOnDay(index, ordinal))
  for (const persona of posters) {
    planned += Number(await insertJob({ day, userId: persona.userId, kind: 'post', suffix: 'daily' }))
  }

  const recentPosts = await query(
    `SELECT p.id, p.user_id, p.position
     FROM posts p
     JOIN userdata u ON u.id = p.user_id
     WHERE u.is_demo = TRUE AND NOT p.hidden AND p.created_at >= NOW() - INTERVAL '21 days'
     ORDER BY p.created_at DESC
     LIMIT 80`
  )
  const recentComments = await query(
    `SELECT c.id, c.user_id
     FROM comments c
     JOIN userdata u ON u.id = c.user_id
     WHERE u.is_demo = TRUE AND NOT c.hidden AND c.created_at >= NOW() - INTERVAL '14 days'
     ORDER BY c.created_at DESC
     LIMIT 100`
  )

  for (let index = 0; index < personas.length; index++) {
    const persona = personas[index]
    const targets = recentPosts.rows.filter((post) => post.user_id !== persona.userId)
    if (targets.length > 0) {
      const target = targets[Math.floor(hashUnit(`${day}:post:${persona.cadenceSeed}`) * targets.length)]
      if ((index + ordinal) % 2 === 0) {
        planned += Number(await insertJob({
          day,
          userId: persona.userId,
          kind: 'post_comment',
          targetId: String(target.id),
          suffix: String(target.id),
        }))
      }
      planned += Number(await insertJob({
        day,
        userId: persona.userId,
        kind: 'post_vote',
        targetId: String(target.id),
        payload: {
          direction: demoVoteDirection(
            persona.lean,
            target.position == null ? null : Number(target.position),
            `${day}:${persona.userId}:${target.id}`
          ),
        },
        suffix: String(target.id),
      }))
    }

    if (recentComments.rows.length > 0 && (index + ordinal) % 3 === 0) {
      const candidates = recentComments.rows.filter((comment) => comment.user_id !== persona.userId)
      if (candidates.length > 0) {
        const target = candidates[Math.floor(hashUnit(`${day}:comment:${persona.cadenceSeed}`) * candidates.length)]
        planned += Number(await insertJob({
          day,
          userId: persona.userId,
          kind: 'comment_vote',
          targetId: String(target.id),
          payload: { direction: hashUnit(`${day}:${target.id}:comment-vote`) < 0.82 ? 'up' : 'down' },
          suffix: String(target.id),
        }))
      }
    }
  }

  // Give every incoming feed-eligible publisher card a small, coherent sample
  // of fictional community reactions. Selecting only articles with no prior
  // article-vote job lets a bounded planning pass eventually cover a burst of
  // any size instead of permanently skipping everything after the newest 30.
  // Global article/persona keys prevent duplicates across cron passes.
  const incomingArticles = await query(
    `SELECT a.id, a.title, a.source,
            COALESCE(a.political_lean, a.source_lean) AS position,
            COALESCE(g.name, '') AS topic,
            a.subtopic_id
     FROM articles a
     LEFT JOIN general_topics g ON g.id = a.general_topic_id
     WHERE a.status = 'ready'
       AND a.created_at >= NOW() - INTERVAL '24 hours'
       AND COALESCE(a.published_at, a.created_at) <= NOW()
       AND a.title IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM demo_activity_jobs job
         WHERE job.kind = 'article_vote' AND job.target_id = a.id::text
       )
     ORDER BY a.created_at
     LIMIT 200`
  )
  for (const row of incomingArticles.rows) {
    const article = {
      id: String(row.id),
      title: String(row.title),
      source: String(row.source ?? 'Publisher'),
      topic: String(row.topic ?? ''),
      position: row.position == null ? null : Number(row.position),
    }
    const ranked = [...personas].sort(
      (left, right) => articleAffinity(right, article) - articleAffinity(left, article)
    )
    // Plan one article atomically. If a process exits halfway through, the
    // NOT EXISTS selector can retry the entire card on the next cron pass.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const runQuery = (text: string, values: unknown[]) => client.query(text, values)
      let articlePlanned = 0
      const voters = ranked.slice(0, demoArticleVoterCount(article.id, ranked.length))
      for (const persona of voters) {
        const dedupeKey = `article:${article.id}:vote:${persona.userId}`
        articlePlanned += Number(await insertJob({
          day,
          userId: persona.userId,
          kind: 'article_vote',
          targetId: article.id,
          payload: {
            direction: demoVoteDirection(
              persona.lean,
              article.position,
              `${article.id}:${persona.userId}:article-vote`
            ),
          },
          suffix: article.id,
          dedupeKey,
          offsetMinutes: articleEngagementOffsetMinutes(dedupeKey),
          runQuery,
        }))
      }

      // A minority also receive one headline-grounded fictional comment, with
      // a modest preference for multi-source stories. Votes provide broad
      // visible activity; generated prose stays rare.
      if (
        ranked.length > 0 &&
        demoArticleShouldReceiveComment(article.id, row.subtopic_id != null)
      ) {
        const commenter = ranked[0]
        const dedupeKey = `article:${article.id}:comment:${commenter.userId}`
        articlePlanned += Number(await insertJob({
          day,
          userId: commenter.userId,
          kind: 'article_comment',
          targetId: article.id,
          suffix: article.id,
          dedupeKey,
          offsetMinutes: articleEngagementOffsetMinutes(dedupeKey),
          runQuery,
        }))
      }
      await client.query('COMMIT')
      planned += articlePlanned
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  await ensureTodaysDebates()
  const debates = await query(
    `SELECT id, title FROM debates
     WHERE debate_date = (NOW() AT TIME ZONE 'America/New_York')::date
     ORDER BY created_at`
  )
  for (const debate of debates.rows) {
    const ranked = [...personas].sort(
      (left, right) =>
        hashUnit(`${day}:${debate.id}:${left.cadenceSeed}`) -
        hashUnit(`${day}:${debate.id}:${right.cadenceSeed}`)
    )
    const voters = ranked.slice(0, Math.min(12, ranked.length))
    for (const persona of voters) {
      const jitter = (hashUnit(`${day}:${debate.id}:${persona.userId}:pin`) - 0.5) * 0.24
      const position = Math.max(0.02, Math.min(0.98, persona.lean + jitter))
      planned += Number(await insertJob({
        day,
        userId: persona.userId,
        kind: 'debate_vote',
        targetId: String(debate.id),
        payload: { position: Number(position.toFixed(3)) },
        suffix: String(debate.id),
      }))
    }
    for (const persona of ranked.slice(12, 14)) {
      planned += Number(await insertJob({
        day,
        userId: persona.userId,
        kind: 'debate_comment',
        targetId: String(debate.id),
        suffix: String(debate.id),
      }))
    }
  }

  return planned
}

type ActivityLane = 'vote' | 'content'

const VOTE_KINDS: DemoActivityKind[] = [
  'article_vote',
  'post_vote',
  'comment_vote',
  'debate_vote',
]
const CONTENT_KINDS: DemoActivityKind[] = [
  'post',
  'article_comment',
  'post_comment',
  'debate_comment',
]

async function claimDueJob(lane: ActivityLane): Promise<ActivityJob | null> {
  const kinds = lane === 'vote' ? VOTE_KINDS : CONTENT_KINDS
  const result = await query(
    `WITH next_job AS (
       SELECT id FROM demo_activity_jobs
       WHERE status = 'queued' AND scheduled_for <= NOW() AND kind = ANY($1::text[])
       ORDER BY
         CASE kind
           WHEN 'article_vote' THEN 0
           WHEN 'post' THEN 0
           WHEN 'article_comment' THEN 1
           WHEN 'post_vote' THEN 1
           WHEN 'comment_vote' THEN 2
           WHEN 'post_comment' THEN 2
           ELSE 3
         END,
         scheduled_for,
         id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE demo_activity_jobs job
     SET status = 'running', attempts = attempts + 1, last_error = NULL
     FROM next_job
     WHERE job.id = next_job.id
     RETURNING job.id, job.user_id, job.kind, job.target_id, job.payload, job.attempts`,
    [kinds]
  )
  return (result.rows[0] as ActivityJob | undefined) ?? null
}

async function personaForJob(userId: string): Promise<DemoPersona | null> {
  const user = await query(
    `SELECT u.username, p.lean, p.role, p.voice, p.interests, p.cadence_seed
     FROM userdata u
     JOIN demo_personas p ON p.user_id = u.id
     WHERE u.id = $1 AND u.is_demo = TRUE AND p.active = TRUE`,
    [userId]
  )
  const row = user.rows[0]
  if (!row) return null
  return {
    username: String(row.username),
    lean: Number(row.lean),
    role: String(row.role),
    voice: String(row.voice),
    interests: (row.interests ?? []).map(String),
    cadenceSeed: Number(row.cadence_seed),
  }
}

async function createPost(job: ActivityJob, persona: DemoPersona): Promise<void> {
  const expected = demoPerspective(persona.lean)
  let generated = await generateDemoPost(persona)
  let score = scorePost(generated.text)

  if (!demoScoreMatchesPersona(persona.lean, score.position)) {
    const observed = score.position == null
      ? 'the wording did not express a classifiable policy stance'
      : `the wording read as ${score.position < 0.5 ? 'left' : 'right'} rather than ${expected}`
    generated = await generateDemoPost(
      persona,
      `${observed}. Rewrite around one explicit policy the persona supports or opposes. Preserve nuance and natural language.`
    )
    score = scorePost(generated.text)
  }
  if (!demoScoreMatchesPersona(persona.lean, score.position)) {
    // Let the queued job retry with a fresh model generation. Publishing no
    // post is preferable to filling the feed with a visible generic template.
    throw new Error(`Generated ${expected} demo post remained directionally inconsistent`)
  }
  const topic = await matchTopic(`${generated.text} ${generated.hashtags.join(' ')}`)
  await query(
    `INSERT INTO posts
       (user_id, content, general_topic_id, hashtags, position, position_confidence,
        position_signals, scorer_version, recommendation_embedding, is_demo_generated, demo_job_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10)
     ON CONFLICT (demo_job_id) WHERE demo_job_id IS NOT NULL DO NOTHING`,
    [
      job.user_id,
      generated.text,
      topic.generalTopicId,
      generated.hashtags,
      score.position,
      score.confidence,
      score.signals,
      score.scorer_version,
      semanticEmbedding(generated.text),
      job.id,
    ]
  )
}

async function createComment(job: ActivityJob, persona: DemoPersona): Promise<void> {
  if (!job.target_id) throw new Error('Comment job has no target')
  if (job.kind === 'post_comment') {
    const target = await query(
      `SELECT p.id, p.content, p.position, u.username
       FROM posts p JOIN userdata u ON u.id = p.user_id
       WHERE p.id::text = $1 AND u.is_demo = TRUE AND NOT p.hidden`,
      [job.target_id]
    )
    if (!target.rows[0]) throw new Error('SKIP: demo post target is unavailable')
    const content = await generateDemoComment(persona, {
      kind: 'post',
      text: String(target.rows[0].content ?? ''),
      author: String(target.rows[0].username),
      position: target.rows[0].position == null ? null : Number(target.rows[0].position),
    })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query(
        `INSERT INTO comments (user_id, post_id, content, is_demo_generated, demo_job_id)
         VALUES ($1, $2, $3, TRUE, $4)
         ON CONFLICT (demo_job_id) WHERE demo_job_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [job.user_id, job.target_id, content, job.id]
      )
      if (inserted.rows[0]) {
        await client.query('UPDATE posts SET commentcount = commentcount + 1 WHERE id::text = $1', [job.target_id])
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    return
  }

  if (job.kind === 'article_comment') {
    const target = await query(
      `SELECT id, title, source
       FROM articles
       WHERE id::text = $1 AND status = 'ready'`,
      [job.target_id]
    )
    if (!target.rows[0]) throw new Error('SKIP: article target is unavailable')
    const content = await generateDemoComment(persona, {
      kind: 'article',
      text: String(target.rows[0].title ?? ''),
      author: String(target.rows[0].source ?? 'Publisher'),
    })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query(
        `INSERT INTO comments (user_id, article_id, content, is_demo_generated, demo_job_id)
         VALUES ($1, $2, $3, TRUE, $4)
         ON CONFLICT (demo_job_id) WHERE demo_job_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [job.user_id, job.target_id, content, job.id]
      )
      if (inserted.rows[0]) {
        await client.query(
          'UPDATE articles SET commentcount = commentcount + 1 WHERE id::text = $1',
          [job.target_id]
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    return
  }

  const debate = await query('SELECT id, title FROM debates WHERE id::text = $1', [job.target_id])
  if (!debate.rows[0]) throw new Error('SKIP: debate target is unavailable')
  const content = await generateDemoComment(persona, {
    kind: 'debate',
    text: String(debate.rows[0].title),
  })
  await query(
    `INSERT INTO comments (user_id, debate_id, content, is_demo_generated, demo_job_id)
     VALUES ($1, $2, $3, TRUE, $4)
     ON CONFLICT (demo_job_id) WHERE demo_job_id IS NOT NULL DO NOTHING`,
    [job.user_id, job.target_id, content, job.id]
  )
}

async function executeVote(job: ActivityJob): Promise<void> {
  if (!job.target_id) throw new Error('Vote job has no target')
  if (job.kind === 'debate_vote') {
    const position = Number(job.payload.position)
    if (!Number.isFinite(position) || position < 0 || position > 1) throw new Error('Invalid demo debate position')
    await query(
      `INSERT INTO debate_votes (user_id, debate_id, position)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, debate_id) DO UPDATE SET position = EXCLUDED.position, created_at = NOW()`,
      [job.user_id, job.target_id, position]
    )
    return
  }
  if (job.kind === 'article_vote') {
    const direction = job.payload.direction === 'down' ? 'down' : 'up'
    const target = await query(
      `SELECT 1 FROM articles WHERE id::text = $1 AND status = 'ready'`,
      [job.target_id]
    )
    if (!target.rows[0]) throw new Error('SKIP: article vote target is unavailable')
    await query(
      `INSERT INTO article_votes (user_id, article_id, direction)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, article_id) DO UPDATE SET direction = EXCLUDED.direction, created_at = NOW()`,
      [job.user_id, job.target_id, direction]
    )
    await query(
      `UPDATE articles SET
         upvotes = (SELECT count(*) FROM article_votes WHERE article_id::text = $1 AND direction = 'up'),
         downvotes = (SELECT count(*) FROM article_votes WHERE article_id::text = $1 AND direction = 'down')
       WHERE id::text = $1`,
      [job.target_id]
    )
    return
  }
  const direction = job.payload.direction === 'down' ? 'down' : 'up'
  const table = job.kind === 'post_vote' ? 'votes' : 'comment_votes'
  const targetColumn = job.kind === 'post_vote' ? 'post_id' : 'comment_id'
  const targetTable = job.kind === 'post_vote' ? 'posts' : 'comments'
  const owner = await query(
    `SELECT 1 FROM ${targetTable} target
     JOIN userdata u ON u.id = target.user_id
     WHERE target.id::text = $1 AND u.is_demo = TRUE`,
    [job.target_id]
  )
  if (!owner.rows[0]) throw new Error('SKIP: vote target is not demo content')
  await query(
    `INSERT INTO ${table} (user_id, ${targetColumn}, direction)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, ${targetColumn}) DO UPDATE SET direction = EXCLUDED.direction, created_at = NOW()`,
    [job.user_id, job.target_id, direction]
  )
  if (job.kind === 'post_vote') {
    await query(
      `UPDATE posts SET
         upvotes = (SELECT count(*) FROM votes WHERE post_id::text = $1 AND direction = 'up'),
         downvotes = (SELECT count(*) FROM votes WHERE post_id::text = $1 AND direction = 'down')
       WHERE id::text = $1`,
      [job.target_id]
    )
  } else {
    await query(
      `UPDATE comments SET
         upvotes = (SELECT count(*) FROM comment_votes WHERE comment_id::text = $1 AND direction = 'up'),
         downvotes = (SELECT count(*) FROM comment_votes WHERE comment_id::text = $1 AND direction = 'down')
       WHERE id::text = $1`,
      [job.target_id]
    )
  }
}

async function executeJob(job: ActivityJob): Promise<void> {
  const persona = await personaForJob(job.user_id)
  if (!persona) throw new Error('SKIP: demo persona is inactive or missing')
  if (job.kind === 'post') return createPost(job, persona)
  if (job.kind === 'post_comment' || job.kind === 'article_comment' || job.kind === 'debate_comment') {
    return createComment(job, persona)
  }
  return executeVote(job)
}

async function finishJob(job: ActivityJob, status: 'completed' | 'skipped'): Promise<void> {
  await query(
    `UPDATE demo_activity_jobs
     SET status = $2, executed_at = NOW(), last_error = NULL
     WHERE id = $1`,
    [job.id, status]
  )
}

async function failJob(job: ActivityJob, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  const skipped = message.startsWith('SKIP:')
  if (skipped) return finishJob(job, 'skipped')
  const retry = job.attempts < 3
  await query(
    `UPDATE demo_activity_jobs
     SET status = $2,
         scheduled_for = CASE WHEN $2 = 'queued' THEN NOW() + INTERVAL '30 minutes' ELSE scheduled_for END,
         executed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE executed_at END,
         last_error = $3
     WHERE id = $1`,
    [job.id, retry ? 'queued' : 'failed', message.slice(0, 500)]
  )
  if (!retry) captureException(error, { component: 'demo-activity', jobId: job.id, kind: job.kind })
}

type DemoActivityOptions = {
  voteLimit?: number
  contentLimit?: number
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(maximum, Math.floor(value!)))
}

export async function runDemoActivity(
  options: DemoActivityOptions = {}
): Promise<{ planned: number; completed: number; failed: number }> {
  if (process.env.DEMO_ACTIVITY_ENABLED !== 'yes') {
    console.log('[demo] activity disabled; set DEMO_ACTIVITY_ENABLED=yes to run')
    return { planned: 0, completed: 0, failed: 0 }
  }
  const voteLimit = boundedLimit(options.voteLimit, 300, 1_000)
  const contentLimit = boundedLimit(options.contentLimit, 8, 40)
  const lockClient = await pool.connect()
  try {
    await lockClient.query('BEGIN')
    const lock = await lockClient.query(
      "SELECT pg_try_advisory_xact_lock(hashtext('forum-demo-activity')) AS locked"
    )
    if (!lock.rows[0]?.locked) {
      console.log('[demo] another activity worker holds the lock; skipping')
      return { planned: 0, completed: 0, failed: 0 }
    }
    const personas = await syncPersonas()
    const planned = await planDailyActivity(personas)
    let completed = 0
    let failed = 0
    const laneResults: Record<ActivityLane, { completed: number; failed: number }> = {
      vote: { completed: 0, failed: 0 },
      content: { completed: 0, failed: 0 },
    }
    for (const [lane, limit] of [
      ['vote', voteLimit],
      ['content', contentLimit],
    ] as const) {
      for (let index = 0; index < limit; index++) {
        const job = await claimDueJob(lane)
        if (!job) break
        try {
          await executeJob(job)
          await finishJob(job, 'completed')
          completed++
          laneResults[lane].completed++
        } catch (error) {
          await failJob(job, error)
          failed++
          laneResults[lane].failed++
        }
      }
    }
    console.log(
      `[demo] ${personas.length} personas; ${planned} planned; ` +
      `${laneResults.vote.completed}/${voteLimit} vote jobs and ` +
      `${laneResults.content.completed}/${contentLimit} content jobs completed; ` +
      `${failed} retried/failed`
    )
    return { planned, completed, failed }
  } finally {
    // The transaction pins the PgBouncer backend and releases the lock even
    // if the process exits through an error path. Session locks can leak when
    // a pooled backend outlives the Node process.
    await lockClient.query('ROLLBACK').catch(() => undefined)
    lockClient.release()
  }
}
