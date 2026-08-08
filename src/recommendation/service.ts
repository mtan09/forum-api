import { randomUUID } from 'node:crypto'
import { query } from '../db'
import { articleSocialFields, postSocialFields } from '../lib/content-social'
import {
  POST_WEIGHT,
  VOTE_WEIGHT,
  spectrumPosition,
  voteValue,
  type SpectrumEvent,
} from '../lib/spectrum'
import {
  type CandidateKind,
  type ContentPreference,
  type FeedMode,
  FEED_ALGORITHM_VERSION,
  type RecommendationCandidate,
  type RecommendationProfile,
  rankCandidates,
} from './rank'
import {
  combineVectors,
  interestEmbedding,
  INTEREST_CATALOG,
  semanticEmbedding,
  type InterestDefinition,
} from './semantic'

const CANDIDATE_LIMIT = 500

type CursorData = {
  version: 1
  offset: number
  seed: string
  snapshot: string
  sessionId: string
}

type FeedPage = {
  algorithm_version: string
  session_id: string
  items: {
    kind: CandidateKind
    data: Record<string, unknown>
    recommendation_reason: string
    recommendation_signals: Record<string, number>
  }[]
  next_cursor: string | null
}

function encodeCursor(cursor: CursorData): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeCursor(value: string | undefined): CursorData | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as CursorData
    if (
      parsed.version !== 1 ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 0 ||
      !parsed.seed ||
      !parsed.sessionId ||
      Number.isNaN(new Date(parsed.snapshot).getTime())
    ) return null
    return parsed
  } catch {
    return null
  }
}

const asVector = (value: unknown, fallback: string): number[] => {
  if (Array.isArray(value) && value.length > 0) return value.map(Number)
  return semanticEmbedding(fallback)
}

function eventWeight(eventType: string, dwellMs: number | null): number {
  if (eventType === 'open') return 1.2
  if (eventType === 'outbound_open') return 2.2
  if (eventType === 'dwell') return Math.min(2, Math.max(0, Number(dwellMs ?? 0) / 15_000))
  if (eventType === 'not_interested') return -3
  return 0
}

// The same placement the profile shows. Shares lib/spectrum.ts with
// /users/me/spectrum so the feed and the profile can never disagree.
async function loadSpectrum(userId: string, asOf: Date): Promise<number> {
  const [ownPosts, postVotes, articleVotes] = await Promise.all([
    query(
      'SELECT position, created_at FROM posts WHERE user_id = $1 AND position IS NOT NULL',
      [userId]
    ),
    query(
      `SELECT v.direction, p.position AS lean, v.created_at
       FROM votes v JOIN posts p ON p.id = v.post_id
       WHERE v.user_id = $1 AND p.user_id <> $1 AND p.position IS NOT NULL`,
      [userId]
    ),
    query(
      `SELECT v.direction, COALESCE(a.political_lean, a.source_lean) AS lean, v.created_at
       FROM article_votes v JOIN articles a ON a.id = v.article_id
       WHERE v.user_id = $1 AND COALESCE(a.political_lean, a.source_lean) IS NOT NULL`,
      [userId]
    ),
  ])
  const events: SpectrumEvent[] = [
    ...ownPosts.rows.map((row) => ({
      at: new Date(String(row.created_at)),
      weight: POST_WEIGHT,
      value: Number(row.position),
    })),
    ...[...postVotes.rows, ...articleVotes.rows].map((row) => ({
      at: new Date(String(row.created_at)),
      weight: VOTE_WEIGHT,
      value: voteValue(String(row.direction), Number(row.lean)),
    })),
  ]
  return spectrumPosition(events, asOf)
}

async function loadProfile(userId: string, snapshot: Date): Promise<{
  profile: RecommendationProfile
  interests: InterestDefinition[]
  sourceAffinity: Map<string, number>
}> {
  const [interestRows, behaviorRows, spectrum, sourceRows] = await Promise.all([
    query('SELECT interest_key, weight FROM user_interests WHERE user_id = $1', [userId]),
    query(
      `WITH weighted AS (
         SELECT 'post'::text AS kind, p.id AS item_id, 2.0::float AS weight,
                NULL::text AS event_type, NULL::int AS dwell_ms
         FROM posts p WHERE p.user_id = $1 AND p.position IS NOT NULL
         UNION ALL
         SELECT 'post', v.post_id, CASE WHEN v.direction = 'up' THEN 2.5 ELSE 0.6 END,
                NULL, NULL
         FROM votes v WHERE v.user_id = $1
         UNION ALL
         SELECT 'article', v.article_id, CASE WHEN v.direction = 'up' THEN 2.5 ELSE 0.6 END,
                NULL, NULL
         FROM article_votes v WHERE v.user_id = $1
         UNION ALL
         SELECT CASE WHEN b.post_id IS NOT NULL THEN 'post' ELSE 'article' END,
                COALESCE(b.post_id, b.article_id), 3.0, NULL, NULL
         FROM bookmarks b WHERE b.user_id = $1
         UNION ALL
         SELECT fe.item_type, fe.item_id, 0, fe.event_type, fe.dwell_ms
         FROM feed_events fe
         WHERE fe.user_id = $1 AND fe.created_at <= $2
           AND fe.created_at > $2 - INTERVAL '90 days'
           AND fe.event_type IN ('open', 'outbound_open', 'dwell', 'not_interested')
       )
       SELECT w.kind, w.weight, w.event_type, w.dwell_ms,
              p.content AS post_text, p.recommendation_embedding AS post_embedding,
              a.title AS article_title,
              a.recommendation_embedding AS article_embedding
       FROM weighted w
       LEFT JOIN posts p ON w.kind = 'post' AND p.id = w.item_id
       LEFT JOIN articles a ON w.kind = 'article' AND a.id = w.item_id
       WHERE p.id IS NOT NULL OR a.id IS NOT NULL
       ORDER BY w.weight DESC
       LIMIT 240`,
      [userId, snapshot]
    ),
    loadSpectrum(userId, snapshot),
    query(
      `SELECT lower(a.source) AS source,
              sum(CASE
                WHEN fe.event_type = 'outbound_open' THEN 2.0
                WHEN fe.event_type = 'open' THEN 1.0
                WHEN fe.event_type = 'dwell' THEN LEAST(1.5, COALESCE(fe.dwell_ms, 0) / 15000.0)
                ELSE 0
              END)::float AS affinity
       FROM feed_events fe JOIN articles a ON fe.item_type = 'article' AND a.id = fe.item_id
       WHERE fe.user_id = $1 AND fe.created_at <= $2
         AND fe.created_at > $2 - INTERVAL '90 days'
       GROUP BY lower(a.source)`,
      [userId, snapshot]
    ),
  ])

  const byKey = new Map(INTEREST_CATALOG.map((interest) => [interest.key, interest]))
  const interests = interestRows.rows
    .map((row) => byKey.get(String(row.interest_key)))
    .filter((interest): interest is InterestDefinition => !!interest)
  const explicitVector = combineVectors(interestRows.rows.map((row) => ({
    vector: interestEmbedding(String(row.interest_key)),
    weight: Number(row.weight),
  })))
  const behaviorVector = combineVectors(behaviorRows.rows.map((row) => {
    const isPost = row.kind === 'post'
    const text = isPost
      ? String(row.post_text ?? '')
      : `${row.article_title ?? ''}. ${row.article_title ?? ''}`
    return {
      vector: asVector(isPost ? row.post_embedding : row.article_embedding, text),
      weight: Number(row.weight) + eventWeight(String(row.event_type ?? ''), row.dwell_ms),
    }
  }))
  const maxAffinity = Math.max(1, ...sourceRows.rows.map((row) => Number(row.affinity ?? 0)))
  const sourceAffinity = new Map(
    sourceRows.rows.map((row) => [String(row.source), Number(row.affinity ?? 0) / maxAffinity])
  )
  return {
    profile: {
      position: spectrum,
      explicitVector,
      behaviorVector,
      selectedInterestLabels: interests.map((interest) => interest.label),
    },
    interests,
    sourceAffinity,
  }
}

const POST_DATA_FIELDS = [
  'id', 'user_id', 'content', 'media_url', 'general_topic_id', 'position',
  'position_confidence', 'position_signals', 'scorer_version', 'hashtags',
  'upvotes', 'downvotes', 'commentcount', 'created_at', 'username', 'avatar_url', 'is_demo',
  'my_vote', 'my_bookmark', 'repost_count', 'my_repost', 'quoted_content',
  'reposted_by_user_id', 'reposted_by_username', 'reposted_by_avatar_url',
  'reposted_by_is_demo', 'reposted_at',
]
const ARTICLE_DATA_FIELDS = [
  'id', 'url', 'title', 'source', 'media', 'political_lean', 'political_relevance',
  'lean_confidence', 'content_type', 'lean_signals', 'source_lean', 'scorer_version',
  'upvotes', 'downvotes', 'commentcount', 'general_topic_id', 'subtopic_id',
  'published_at', 'status', 'created_at', 'ai_context_allowed', 'my_vote', 'my_bookmark',
  'repost_count', 'my_repost', 'reposted_by_user_id', 'reposted_by_username',
  'reposted_by_avatar_url', 'reposted_by_is_demo', 'reposted_at',
]

const projectData = (row: Record<string, unknown>, fields: string[]) =>
  Object.fromEntries(fields.map((field) => [field, row[field]]))

async function loadPostCandidates(
  userId: string,
  snapshot: Date,
  topicSlugs: string[],
  includeFollowedReposts: boolean,
): Promise<Record<string, unknown>[]> {
  const result = await query(
    `WITH candidate_ids AS (
       (SELECT p.id FROM posts p
        WHERE NOT p.hidden AND p.user_id <> $1 AND p.created_at <= $2
        ORDER BY p.created_at DESC LIMIT 160)
       UNION
       (SELECT p.id FROM posts p
        WHERE NOT p.hidden AND p.user_id <> $1 AND p.created_at <= $2
          AND p.created_at > $2 - INTERVAL '60 days'
        ORDER BY (p.upvotes * 2 + p.commentcount * 3 - p.downvotes)::float /
                 GREATEST(4, EXTRACT(EPOCH FROM ($2 - p.created_at)) / 3600 + 2) DESC
        LIMIT 90)
       UNION
       (SELECT p.id FROM posts p JOIN general_topics g ON g.id = p.general_topic_id
        WHERE NOT p.hidden AND p.user_id <> $1 AND p.created_at <= $2
          AND g.slug = ANY($3::text[])
        ORDER BY p.created_at DESC LIMIT 100)
       UNION
       (SELECT p.id FROM posts p JOIN follows f ON f.followee_id = p.user_id
        WHERE f.follower_id = $1 AND f.status = 'accepted'
          AND NOT p.hidden AND p.created_at <= $2
        ORDER BY p.created_at DESC LIMIT 100)
       UNION
       (SELECT r.post_id
        FROM reposts r
        JOIN follows f ON f.followee_id = r.user_id
        JOIN posts p ON p.id = r.post_id
        WHERE $4::boolean AND f.follower_id = $1 AND f.status = 'accepted'
          AND r.user_id <> $1 AND r.created_at <= $2 AND NOT p.hidden
        ORDER BY r.created_at DESC LIMIT 120)
     )
     SELECT p.id, p.user_id, p.content, p.media_url, p.general_topic_id, p.position,
            p.position_confidence, p.position_signals, p.scorer_version, p.hashtags,
            p.upvotes, p.downvotes, p.commentcount, p.created_at,
            p.recommendation_embedding, u.username, u.avatar_url, u.is_demo,
            v.direction AS my_vote,
            EXISTS(SELECT 1 FROM bookmarks b WHERE b.post_id = p.id AND b.user_id = $1) AS my_bookmark,
            ${postSocialFields('p', '$1')},
            (EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = p.user_id AND f.status = 'accepted')
              OR followed_repost.user_id IS NOT NULL) AS followed,
            followed_repost.user_id AS reposted_by_user_id,
            followed_repost.username AS reposted_by_username,
            followed_repost.avatar_url AS reposted_by_avatar_url,
            followed_repost.is_demo AS reposted_by_is_demo,
            followed_repost.created_at AS reposted_at,
            EXISTS(SELECT 1 FROM feed_events fe WHERE fe.user_id = $1 AND fe.item_type = 'post' AND fe.item_id = p.id AND fe.event_type = 'impression' AND fe.created_at > $2 - INTERVAL '7 days') AS recently_seen,
            COALESCE(metrics.impressions, 0)::int AS impressions,
            COALESCE(metrics.opens, 0)::int AS opens,
            COALESCE(metrics.average_dwell_ms, 0)::float AS average_dwell_ms
     FROM candidate_ids ids
     JOIN posts p ON p.id = ids.id
     JOIN userdata u ON u.id = p.user_id
     LEFT JOIN votes v ON v.post_id = p.id AND v.user_id = $1
     LEFT JOIN LATERAL (
       SELECT r.user_id, reposter.username, reposter.avatar_url, reposter.is_demo, r.created_at
       FROM reposts r
       JOIN follows f ON f.followee_id = r.user_id
         AND f.follower_id = $1 AND f.status = 'accepted'
       JOIN userdata reposter ON reposter.id = r.user_id
       WHERE $4::boolean AND r.post_id = p.id AND r.user_id <> $1
         AND r.created_at <= $2
         AND NOT EXISTS (
           SELECT 1 FROM blocks blocked
           WHERE (blocked.blocker_id = $1 AND blocked.blocked_id = r.user_id)
              OR (blocked.blocker_id = r.user_id AND blocked.blocked_id = $1)
         )
       ORDER BY r.created_at DESC
       LIMIT 1
     ) followed_repost ON TRUE
     LEFT JOIN LATERAL (
       SELECT count(*) FILTER (WHERE event_type = 'impression') AS impressions,
              -- Only 'open': posts have nowhere outbound to go and emit zero
              -- outbound_open events, so counting both inflated article openRate
              -- against identical real engagement.
              count(*) FILTER (WHERE event_type = 'open') AS opens,
              avg(dwell_ms) FILTER (WHERE event_type = 'dwell') AS average_dwell_ms
       FROM feed_events fe
       WHERE fe.item_type = 'post' AND fe.item_id = p.id
         AND fe.created_at > $2 - INTERVAL '14 days'
     ) metrics ON TRUE
     LEFT JOIN content_preferences cp
       ON cp.user_id = $1 AND cp.item_type = 'post' AND cp.item_id = p.id
     WHERE cp.item_id IS NULL
       AND NOT EXISTS(SELECT 1 FROM blocks bl WHERE bl.blocker_id = $1 AND bl.blocked_id = p.user_id)
     LIMIT 350`,
    [userId, snapshot, topicSlugs, includeFollowedReposts]
  )
  return result.rows
}

async function loadArticleCandidates(
  userId: string,
  snapshot: Date,
  topicSlugs: string[],
  includeFollowedReposts: boolean,
): Promise<Record<string, unknown>[]> {
  const result = await query(
    `WITH candidate_ids AS (
       (SELECT a.id FROM articles a
        WHERE a.status = 'ready' AND COALESCE(a.published_at, a.created_at) <= $2
        ORDER BY a.published_at DESC NULLS LAST LIMIT 180)
       UNION
       (SELECT a.id FROM articles a
        WHERE a.status = 'ready' AND COALESCE(a.published_at, a.created_at) <= $2
          AND COALESCE(a.published_at, a.created_at) > $2 - INTERVAL '14 days'
        ORDER BY (a.upvotes * 2 + a.commentcount * 3 - a.downvotes)::float /
                 GREATEST(3, EXTRACT(EPOCH FROM ($2 - COALESCE(a.published_at, a.created_at))) / 3600 + 1) DESC
        LIMIT 100)
       UNION
       (SELECT a.id FROM articles a JOIN general_topics g ON g.id = a.general_topic_id
        WHERE a.status = 'ready' AND COALESCE(a.published_at, a.created_at) <= $2
          AND g.slug = ANY($3::text[])
        ORDER BY a.published_at DESC NULLS LAST LIMIT 120)
       UNION
       (SELECT r.article_id
        FROM reposts r
        JOIN follows f ON f.followee_id = r.user_id
        JOIN articles a ON a.id = r.article_id
        WHERE $4::boolean AND f.follower_id = $1 AND f.status = 'accepted'
          AND r.user_id <> $1 AND r.created_at <= $2 AND a.status = 'ready'
        ORDER BY r.created_at DESC LIMIT 120)
     )
     SELECT a.id, a.url, a.title, a.source, a.media, a.political_lean,
            a.political_relevance, a.lean_confidence, a.content_type, a.lean_signals,
            a.source_lean, a.scorer_version, a.upvotes, a.downvotes, a.commentcount,
            a.general_topic_id, a.subtopic_id, a.published_at, a.status, a.created_at,
            a.recommendation_embedding, a.ai_context_allowed,
            v.direction AS my_vote,
            EXISTS(SELECT 1 FROM bookmarks b WHERE b.article_id = a.id AND b.user_id = $1) AS my_bookmark,
            ${articleSocialFields('a', '$1')},
            followed_repost.user_id AS reposted_by_user_id,
            followed_repost.username AS reposted_by_username,
            followed_repost.avatar_url AS reposted_by_avatar_url,
            followed_repost.is_demo AS reposted_by_is_demo,
            followed_repost.created_at AS reposted_at,
            EXISTS(SELECT 1 FROM feed_events fe WHERE fe.user_id = $1 AND fe.item_type = 'article' AND fe.item_id = a.id AND fe.event_type = 'impression' AND fe.created_at > $2 - INTERVAL '7 days') AS recently_seen,
            COALESCE(metrics.impressions, 0)::int AS impressions,
            COALESCE(metrics.opens, 0)::int AS opens,
            COALESCE(metrics.average_dwell_ms, 0)::float AS average_dwell_ms
     FROM candidate_ids ids
     JOIN articles a ON a.id = ids.id
     LEFT JOIN article_votes v ON v.article_id = a.id AND v.user_id = $1
     LEFT JOIN LATERAL (
       SELECT r.user_id, reposter.username, reposter.avatar_url, reposter.is_demo, r.created_at
       FROM reposts r
       JOIN follows f ON f.followee_id = r.user_id
         AND f.follower_id = $1 AND f.status = 'accepted'
       JOIN userdata reposter ON reposter.id = r.user_id
       WHERE $4::boolean AND r.article_id = a.id AND r.user_id <> $1
         AND r.created_at <= $2
         AND NOT EXISTS (
           SELECT 1 FROM blocks blocked
           WHERE (blocked.blocker_id = $1 AND blocked.blocked_id = r.user_id)
              OR (blocked.blocker_id = r.user_id AND blocked.blocked_id = $1)
         )
       ORDER BY r.created_at DESC
       LIMIT 1
     ) followed_repost ON TRUE
     LEFT JOIN LATERAL (
       SELECT count(*) FILTER (WHERE event_type = 'impression') AS impressions,
              -- Only 'open': posts have nowhere outbound to go and emit zero
              -- outbound_open events, so counting both inflated article openRate
              -- against identical real engagement.
              count(*) FILTER (WHERE event_type = 'open') AS opens,
              avg(dwell_ms) FILTER (WHERE event_type = 'dwell') AS average_dwell_ms
       FROM feed_events fe
       WHERE fe.item_type = 'article' AND fe.item_id = a.id
         AND fe.created_at > $2 - INTERVAL '14 days'
     ) metrics ON TRUE
     LEFT JOIN content_preferences cp
       ON cp.user_id = $1 AND cp.item_type = 'article' AND cp.item_id = a.id
     WHERE cp.item_id IS NULL
     LIMIT 400`,
    [userId, snapshot, topicSlugs, includeFollowedReposts]
  )
  return result.rows
}

export async function personalizedFeed(input: {
  userId: string
  mode: FeedMode
  content: ContentPreference
  limit: number
  cursor?: string
  requestedSessionId?: string
}): Promise<FeedPage> {
  const decoded = decodeCursor(input.cursor)
  if (input.cursor && !decoded) throw new Error('INVALID_FEED_CURSOR')
  const cursor: CursorData = decoded ?? {
    version: 1,
    offset: 0,
    seed: randomUUID(),
    snapshot: new Date().toISOString(),
    sessionId: input.requestedSessionId?.slice(0, 120) || randomUUID(),
  }
  const snapshot = new Date(cursor.snapshot)
  const { profile, interests, sourceAffinity } = await loadProfile(input.userId, snapshot)
  const topicSlugs = [...new Set(interests.flatMap((interest) => interest.topicSlugs))]
  const includeFollowedReposts = input.mode === 'for_you'
  const [postRows, articleRows] = await Promise.all([
    input.content === 'articles' ? Promise.resolve([]) : loadPostCandidates(input.userId, snapshot, topicSlugs, includeFollowedReposts),
    input.content === 'posts' ? Promise.resolve([]) : loadArticleCandidates(input.userId, snapshot, topicSlugs, includeFollowedReposts),
  ])

  let candidates: RecommendationCandidate[] = [
    ...postRows.map((row): RecommendationCandidate => ({
      kind: 'post',
      id: String(row.id),
      timestamp: new Date(String(row.reposted_at ?? row.created_at)),
      lean: row.position == null ? null : Number(row.position),
      topicId: row.general_topic_id == null ? null : String(row.general_topic_id),
      sourceKey: String(row.user_id),
      authorId: String(row.user_id),
      embedding: asVector(row.recommendation_embedding, String(row.content ?? '')),
      upvotes: Number(row.upvotes ?? 0),
      downvotes: Number(row.downvotes ?? 0),
      comments: Number(row.commentcount ?? 0),
      impressions: Number(row.impressions ?? 0),
      opens: Number(row.opens ?? 0),
      averageDwellMs: Number(row.average_dwell_ms ?? 0),
      followed: Boolean(row.followed),
      sourceAffinity: 0,
      recentlySeen: Boolean(row.recently_seen),
      data: projectData(row, POST_DATA_FIELDS),
    })),
    ...articleRows.map((row): RecommendationCandidate => ({
      kind: 'article',
      id: String(row.id),
      timestamp: new Date(String(row.reposted_at ?? row.published_at ?? row.created_at)),
      lean: row.political_lean == null
        ? row.source_lean == null ? null : Number(row.source_lean)
        : Number(row.political_lean),
      topicId: row.general_topic_id == null ? null : String(row.general_topic_id),
      sourceKey: String(row.source ?? '').toLowerCase(),
      authorId: null,
      embedding: asVector(
        row.recommendation_embedding,
        `${row.title ?? ''}. ${row.title ?? ''}`
      ),
      upvotes: Number(row.upvotes ?? 0),
      downvotes: Number(row.downvotes ?? 0),
      comments: Number(row.commentcount ?? 0),
      impressions: Number(row.impressions ?? 0),
      opens: Number(row.opens ?? 0),
      averageDwellMs: Number(row.average_dwell_ms ?? 0),
      followed: row.reposted_by_user_id != null,
      sourceAffinity: sourceAffinity.get(String(row.source ?? '').toLowerCase()) ?? 0,
      recentlySeen: Boolean(row.recently_seen),
      data: projectData(row, ARTICLE_DATA_FIELDS),
    })),
  ]

  if (input.mode === 'against') {
    const centered = Math.abs(profile.position - 0.5) <= 0.05
    candidates = candidates.filter((candidate) => {
      if (candidate.lean == null) return false
      if (centered) return Math.abs(candidate.lean - 0.5) > 0.05
      return profile.position < 0.5 ? candidate.lean > 0.55 : candidate.lean < 0.45
    })
  }

  const ranked = rankCandidates({
    candidates,
    profile,
    mode: input.mode,
    seed: cursor.seed,
    snapshot,
  }).slice(0, CANDIDATE_LIMIT)
  const page = ranked.slice(cursor.offset, cursor.offset + input.limit)
  const nextOffset = cursor.offset + page.length
  return {
    algorithm_version: FEED_ALGORITHM_VERSION,
    session_id: cursor.sessionId,
    items: page.map((item) => ({
      kind: item.kind,
      data: item.data,
      recommendation_reason: item.reason,
      recommendation_signals: item.signals,
    })),
    next_cursor: nextOffset < ranked.length
      ? encodeCursor({ ...cursor, offset: nextOffset })
      : null,
  }
}

export function parseFeedMode(value: string | undefined): FeedMode | null {
  return value === 'for_you' || value === 'random' || value === 'against' ? value : null
}

export function parseContentPreference(value: string | undefined): ContentPreference | null {
  return value === 'all' || value === 'posts' || value === 'articles' ? value : null
}
