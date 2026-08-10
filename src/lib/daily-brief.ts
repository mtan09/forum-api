import { query } from '../db'
import { personalizedFeed } from '../recommendation/service'
import { ensureTodaysDebates } from '../routes/debates'

export const DAILY_BRIEF_HOUR = 7
export const DAILY_BRIEF_RETENTION_DAYS = 7
const DAILY_BRIEF_CONTENT_VERSION = 2

export type DailyBriefActivity = {
  replies: number
  comments: number
  post_upvotes: number
  comment_upvotes: number
  reposts: number
  quotes: number
  followers: number
  follow_requests: number
  unread_dms: number
}

type StoredContent = {
  version?: number
  story_ids: string[]
  /**
   * Outlet and article counts frozen at generation, keyed by story id.
   *
   * A brief is a dated artifact and its numbers have to be dated too. Counting
   * live at read time drifts twice over: clustering reassigns article
   * membership every pass, and the counts are scoped to the edition's window,
   * so a story selected at 07:00 can own no in-window articles by lunchtime and
   * render "0 outlets · 0 articles" — in an email already sent. Observed
   * 2026-08-09 on the Supreme Court card, whose subtopic held 58 articles at
   * the time it displayed zero.
   */
  story_stats?: Record<string, { outlets: number; articles: number }>
  post_ids: string[]
  floor_ids: string[]
  recap_ids: string[]
  activity: DailyBriefActivity
}

export type DailyBrief = {
  id: string
  brief_date: string
  timezone: string
  window_start: string
  window_end: string
  generated_at: string
  seen_at: string | null
  stories: any[]
  posts: any[]
  floor: any[]
  floor_recap: any[]
  activity: DailyBriefActivity
}

export function validTimezone(value: unknown): string | null {
  const timezone = String(value ?? '').trim()
  if (!timezone || timezone.length > 80) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date())
    return timezone
  } catch {
    return null
  }
}

export function localClock(now: Date, timezone: string): {
  date: string
  minutes: number
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '00'
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
  }
}

export const briefIsReady = (now: Date, timezone: string) =>
  localClock(now, timezone).minutes >= DAILY_BRIEF_HOUR * 60

export function dailyBriefDateKey(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const raw = String(value ?? '').trim()
  const isoDate = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0]
  if (isoDate) return isoDate
  const parsed = new Date(raw)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
  throw new Error('Invalid Daily Brief date')
}

const asIds = (rows: any[]) => rows.map((row) => String(row.id))

async function activityFor(userId: string, start: Date, end: Date): Promise<DailyBriefActivity> {
  const result = await query(
    `WITH blocked AS (
       SELECT blocked_id AS actor_id FROM blocks WHERE blocker_id = $1
       UNION SELECT blocker_id FROM blocks WHERE blocked_id = $1
     )
     SELECT
       (SELECT count(*)::int FROM comments c
        JOIN comments parent ON parent.id = c.parent_comment_id
        WHERE parent.user_id = $1 AND c.user_id <> $1
          AND c.created_at >= $2 AND c.created_at < $3
          AND c.user_id NOT IN (SELECT actor_id FROM blocked)) AS replies,
       (SELECT count(*)::int FROM comments c
        JOIN posts p ON p.id = c.post_id
        WHERE p.user_id = $1 AND c.parent_comment_id IS NULL AND c.user_id <> $1
          AND c.created_at >= $2 AND c.created_at < $3
          AND c.user_id NOT IN (SELECT actor_id FROM blocked)) AS comments,
       (SELECT count(*)::int FROM votes v JOIN posts p ON p.id = v.post_id
        WHERE p.user_id = $1 AND v.user_id <> $1 AND v.direction = 'up'
          AND v.created_at >= $2 AND v.created_at < $3
          AND v.user_id NOT IN (SELECT actor_id FROM blocked)) AS post_upvotes,
       (SELECT count(*)::int FROM comment_votes v JOIN comments c ON c.id = v.comment_id
        WHERE c.user_id = $1 AND v.user_id <> $1 AND v.direction = 'up'
          AND v.created_at >= $2 AND v.created_at < $3
          AND v.user_id NOT IN (SELECT actor_id FROM blocked)) AS comment_upvotes,
       (SELECT count(*)::int FROM reposts r JOIN posts p ON p.id = r.post_id
        WHERE p.user_id = $1 AND r.user_id <> $1
          AND r.created_at >= $2 AND r.created_at < $3
          AND r.user_id NOT IN (SELECT actor_id FROM blocked)) AS reposts,
       (SELECT count(*)::int FROM posts q JOIN posts p ON p.id = q.quoted_post_id
        WHERE p.user_id = $1 AND q.user_id <> $1 AND NOT q.hidden
          AND q.created_at >= $2 AND q.created_at < $3
          AND q.user_id NOT IN (SELECT actor_id FROM blocked)) AS quotes,
       (SELECT count(*)::int FROM follows f
        WHERE f.followee_id = $1 AND f.status = 'accepted'
          AND f.created_at >= $2 AND f.created_at < $3
          AND f.follower_id NOT IN (SELECT actor_id FROM blocked)) AS followers,
       (SELECT count(*)::int FROM follows f
        WHERE f.followee_id = $1 AND f.status = 'pending'
          AND f.created_at >= $2 AND f.created_at < $3
          AND f.follower_id NOT IN (SELECT actor_id FROM blocked)) AS follow_requests,
       (SELECT count(*)::int
        FROM conversations conv
        JOIN messages m ON m.conversation_id = conv.id
        LEFT JOIN conversation_reads cr
          ON cr.conversation_id = conv.id AND cr.user_id = $1
        WHERE (conv.a_id = $1 OR conv.b_id = $1)
          AND m.sender_id <> $1 AND NOT m.hidden
          AND m.created_at > COALESCE(cr.last_read_at, conv.created_at)
          -- Bounded to the brief's window like every other counter here. Left
          -- unbounded it was the one all-time figure in a section about the
          -- last 24 hours, so a message ignored months ago inflated every
          -- subsequent edition.
          AND m.created_at >= $2 AND m.created_at < $3
          AND m.sender_id NOT IN (SELECT actor_id FROM blocked)) AS unread_dms`,
    [userId, start, end]
  )
  const row = result.rows[0] ?? {}
  return {
    replies: Number(row.replies ?? 0),
    comments: Number(row.comments ?? 0),
    post_upvotes: Number(row.post_upvotes ?? 0),
    comment_upvotes: Number(row.comment_upvotes ?? 0),
    reposts: Number(row.reposts ?? 0),
    quotes: Number(row.quotes ?? 0),
    followers: Number(row.followers ?? 0),
    follow_requests: Number(row.follow_requests ?? 0),
    unread_dms: Number(row.unread_dms ?? 0),
  }
}

/**
 * Ensure the day's debates exist, at most once per process per UTC day.
 *
 * `generateDailyBrief` runs once per user per delivery pass — up to the whole
 * batch — and again on every `/briefs/today` call, which the client hits on
 * each app foreground. The underlying routine short-circuits once the debates
 * exist, but on the first pass of a new day every user in the batch races it.
 */
let debatesEnsuredFor: string | null = null
let debatesInFlight: Promise<unknown> | null = null

async function ensureDebatesOnce(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  if (debatesEnsuredFor === today) return
  if (!debatesInFlight) {
    debatesInFlight = ensureTodaysDebates()
      .then(() => { debatesEnsuredFor = today })
      .finally(() => { debatesInFlight = null })
  }
  await debatesInFlight
}

async function hydrate(row: any): Promise<DailyBrief> {
  const content = (row.content ?? {}) as StoredContent
  const storyIds = content.story_ids ?? []
  const postIds = content.post_ids ?? []
  const floorIds = content.floor_ids ?? []
  const recapIds = content.recap_ids ?? []
  const [stories, posts, floor, recap] = await Promise.all([
    storyIds.length ? query(
      // Counts must cover the same window the story was selected on. Joining
      // all ready articles reported a cluster's lifetime totals — "12 outlets
      // · 180 articles" for a story picked on the 3 pieces published
      // overnight, inside something presented as a 24-hour brief.
      `SELECT s.id, s.title, s.short_summary, s.volume, s.score,
              count(DISTINCT a.source)::int AS outlet_count,
              count(a.id)::int AS article_count,
              (array_agg(a.media ORDER BY a.published_at DESC) FILTER (WHERE a.media IS NOT NULL))[1] AS media
       -- LEFT JOIN, and lifetime counts as a floor. Editions written before
       -- story_stats existed have no frozen numbers, and an inner join against
       -- a churned membership set would drop the row entirely rather than
       -- merely undercount it.
       FROM subtopics s LEFT JOIN articles a ON a.subtopic_id = s.id AND a.status = 'ready'
       WHERE s.id = ANY($1::uuid[])
       GROUP BY s.id
       ORDER BY array_position($1::uuid[], s.id)`,
      [storyIds]) : Promise.resolve({ rows: [] }),
    postIds.length ? query(
      `SELECT p.id, p.content, p.media_url, p.position, p.upvotes, p.commentcount,
              p.created_at, u.id AS user_id, u.username, u.avatar_url, u.is_demo
       FROM posts p JOIN userdata u ON u.id = p.user_id
       WHERE p.id = ANY($1::uuid[]) AND NOT p.hidden
         AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.blocker_id = $2 AND b.blocked_id = p.user_id)
       ORDER BY array_position($1::uuid[], p.id)`, [postIds, row.user_id]) : Promise.resolve({ rows: [] }),
    floorIds.length ? query(
      `SELECT d.id, d.title, d.kind, d.debate_date,
              count(DISTINCT v.user_id)::int AS total_votes,
              count(DISTINCT c.id)::int AS comment_count
       FROM debates d LEFT JOIN debate_votes v ON v.debate_id = d.id
       LEFT JOIN comments c ON c.debate_id = d.id
       WHERE d.id = ANY($1::uuid[]) GROUP BY d.id
       ORDER BY array_position($1::uuid[], d.id)`, [floorIds]) : Promise.resolve({ rows: [] }),
    recapIds.length ? query(
      `SELECT d.id, d.title, d.kind, d.debate_date,
              count(DISTINCT v.user_id)::int AS total_votes,
              count(DISTINCT c.id)::int AS comment_count,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY v.position) AS median
       FROM debates d LEFT JOIN debate_votes v ON v.debate_id = d.id
       LEFT JOIN comments c ON c.debate_id = d.id
       WHERE d.id = ANY($1::uuid[]) GROUP BY d.id
       ORDER BY array_position($1::uuid[], d.id)`, [recapIds]) : Promise.resolve({ rows: [] }),
  ])
  return {
    id: String(row.id),
    brief_date: dailyBriefDateKey(row.brief_date),
    timezone: String(row.timezone),
    window_start: new Date(row.window_start).toISOString(),
    window_end: new Date(row.window_end).toISOString(),
    generated_at: new Date(row.generated_at).toISOString(),
    seen_at: row.seen_at ? new Date(row.seen_at).toISOString() : null,
    // Frozen counts win. They were computed against the edition's own window
    // at generation; the lifetime numbers from the query above are only a
    // fallback for editions written before story_stats existed, where showing
    // a story's whole history beats showing zero.
    stories: stories.rows.map((story: any) => {
      const frozen = content.story_stats?.[String(story.id)]
      return frozen
        ? { ...story, outlet_count: frozen.outlets, article_count: frozen.articles }
        : story
    }),
    posts: posts.rows,
    floor: floor.rows,
    floor_recap: recap.rows,
    activity: content.activity ?? {
      replies: 0, comments: 0, post_upvotes: 0, comment_upvotes: 0,
      reposts: 0, quotes: 0, followers: 0, follow_requests: 0, unread_dms: 0,
    },
  }
}

export async function generateDailyBrief(
  userId: string,
  timezone: string,
  now = new Date()
): Promise<DailyBrief | null> {
  if (process.env.DAILY_BRIEF_ENABLED === 'no') return null
  const zone = validTimezone(timezone)
  if (!zone || !briefIsReady(now, zone)) return null
  const { date } = localClock(now, zone)
  const existing = await query(
    'SELECT * FROM daily_briefs WHERE user_id = $1 AND brief_date = $2',
    [userId, date]
  )
  if (existing.rows[0]) {
    const existingContent = (existing.rows[0].content ?? {}) as StoredContent
    if (existingContent.version === DAILY_BRIEF_CONTENT_VERSION) {
      return hydrate(existing.rows[0])
    }
  }

  const boundary = await query(
    `SELECT (($1::date - 1) + time '07:00') AT TIME ZONE $2 AS window_start,
            ($1::date + time '07:00') AT TIME ZONE $2 AS window_end`,
    [date, zone]
  )
  const windowStart = new Date(boundary.rows[0].window_start)
  const windowEnd = new Date(boundary.rows[0].window_end)
  await ensureDebatesOnce()

  const [stories, postsPage, floor, recap, activity] = await Promise.all([
    query(
      `SELECT s.id FROM subtopics s
       WHERE s.cluster_key IS NOT NULL AND s.score > 0
         AND EXISTS(
           SELECT 1 FROM articles a
           WHERE a.subtopic_id = s.id AND a.status = 'ready'
             AND a.published_at >= $1 AND a.published_at < $2
         )
       ORDER BY (
         SELECT count(*) FROM articles a
         WHERE a.subtopic_id = s.id AND a.status = 'ready'
           AND a.published_at >= $1 AND a.published_at < $2
       ) DESC, s.score DESC, s.updated_at DESC
       LIMIT 3`,
      [windowStart, windowEnd]
    ),
    personalizedFeed({ userId, mode: 'for_you', content: 'posts', limit: 20 }),
    // "Today" must be the reader's today. Which debates appear is shared
    // rather than personalised, but that justifies a fixed corpus, not a fixed
    // date base: at 07:05 in Tokyo it is still the previous afternoon in New
    // York, so a hardcoded zone served rooms two calendar days behind a reader
    // the brief had just promised "today's leading rooms".
    query(
      `SELECT id FROM debates
       WHERE debate_date = (NOW() AT TIME ZONE $1)::date
       ORDER BY CASE kind WHEN 'biggest' THEN 0 WHEN 'contested' THEN 1 ELSE 2 END, created_at
       LIMIT 2`,
      [zone]
    ),
    query(
      `SELECT id FROM debates
       WHERE debate_date = (NOW() AT TIME ZONE $1)::date - 1
       ORDER BY CASE kind WHEN 'biggest' THEN 0 WHEN 'contested' THEN 1 ELSE 2 END, created_at
       LIMIT 1`,
      [zone]
    ),
    activityFor(userId, windowStart, windowEnd),
  ])
  const storyIdsForBrief = asIds(stories.rows)
  // Freeze the counts now, against the same window the stories were selected
  // on. Recomputing them at read time drifts as clustering churns membership.
  const statsRows = storyIdsForBrief.length
    ? (await query(
        `SELECT s.id,
                count(DISTINCT a.source)::int AS outlets,
                count(a.id)::int AS articles
         FROM subtopics s
         LEFT JOIN articles a ON a.subtopic_id = s.id AND a.status = 'ready'
           AND a.published_at >= $2 AND a.published_at < $3
         WHERE s.id = ANY($1::uuid[])
         GROUP BY s.id`,
        [storyIdsForBrief, windowStart, windowEnd]
      )).rows
    : []
  const storyStats: StoredContent['story_stats'] = {}
  for (const row of statsRows as any[]) {
    storyStats[String(row.id)] = { outlets: Number(row.outlets), articles: Number(row.articles) }
  }

  const stored: StoredContent = {
    version: DAILY_BRIEF_CONTENT_VERSION,
    story_ids: storyIdsForBrief,
    story_stats: storyStats,
    post_ids: postsPage.items
      .filter((item) => item.kind === 'post')
      .filter((item) => {
        const createdAt = new Date(String(item.data.created_at ?? 0)).getTime()
        return createdAt >= windowStart.getTime() && createdAt < windowEnd.getTime()
      })
      .slice(0, 2)
      .map((item) => String(item.data.id)),
    floor_ids: asIds(floor.rows),
    recap_ids: asIds(recap.rows),
    activity,
  }
  const inserted = await query(
    `INSERT INTO daily_briefs
       (user_id, brief_date, timezone, window_start, window_end, content)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, brief_date) DO UPDATE SET
       timezone = EXCLUDED.timezone,
       window_start = EXCLUDED.window_start,
       window_end = EXCLUDED.window_end,
       content = EXCLUDED.content,
       generated_at = NOW()
     RETURNING *`,
    [userId, date, zone, windowStart, windowEnd, stored]
  )
  return hydrate(inserted.rows[0])
}

export async function listDailyBriefs(userId: string, limit = 7): Promise<DailyBrief[]> {
  const rows = await query(
    `SELECT * FROM daily_briefs WHERE user_id = $1
     ORDER BY brief_date DESC LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), DAILY_BRIEF_RETENTION_DAYS)]
  )
  return Promise.all(rows.rows.map(hydrate))
}

export async function getDailyBrief(userId: string, date: string): Promise<DailyBrief | null> {
  const row = await query(
    'SELECT * FROM daily_briefs WHERE user_id = $1 AND brief_date = $2',
    [userId, date]
  )
  return row.rows[0] ? hydrate(row.rows[0]) : null
}

export async function markDailyBriefSeen(userId: string, id: string): Promise<boolean> {
  const result = await query(
    `UPDATE daily_briefs SET seen_at = COALESCE(seen_at, NOW())
     WHERE id = $1 AND user_id = $2`,
    [id, userId]
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Keep the most recent N editions per user.
 *
 * Previously a calendar window: `brief_date < today - 6`. For anyone who does
 * not open the app daily those are different things — a user with editions on
 * the 1st and the 9th holds two, far under the cap, but the older one was
 * deleted anyway. The product promises "the most recent seven editions", so
 * count them.
 */
export async function pruneDailyBriefs(): Promise<number> {
  const result = await query(
    `DELETE FROM daily_briefs WHERE id IN (
       SELECT id FROM (
         SELECT id, row_number() OVER (
           PARTITION BY user_id ORDER BY brief_date DESC
         ) AS rank FROM daily_briefs
       ) ranked WHERE rank > $1::int
     )`,
    [DAILY_BRIEF_RETENTION_DAYS]
  )
  return result.rowCount ?? 0
}
