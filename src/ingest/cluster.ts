// ============================================================
// Story clustering → auto-generated subtopics ("hot topics").
//
// Replaces hand-written subtopics entirely. Deterministic, no LLM:
//  1. Take recent scored articles (RECENT_DAYS window).
//  2. Greedy leader clustering on headline/entity/event-term similarity.
//  3. Keep clusters with enough articles from enough distinct outlets.
//  4. Generate an original coverage note plus attributed headlines. Article
//     body prose is never required or lifted into a summary.
//  5. Match recent user posts to clusters by keyword/hashtag overlap;
//     their scored positions become the cluster's public_position.
//  6. Upsert into subtopics by cluster_key; stale clusters age out of
//     the hot list by score/updated_at, and articles get subtopic_id.
//
// Runs after every ingest pass and via `npm run cluster`.
// ============================================================

import { query } from '../db'
import { metadataKeywordProfile } from './article-metadata'
import { extractKeywords, keywordSimilarity, toHashtags, type Keywords } from './keywords'
import { RIGHTS_POLICY_VERSION } from './source-rights'

const RECENT_DAYS = 7
const SIM_THRESHOLD = 0.23    // metadata profiles are shorter than article bodies
const MIN_ARTICLES = 3        // a story needs corroboration...
const MIN_OUTLETS = 2         // ...from more than one outlet
const MAX_CLUSTERS = 12
const POST_MATCH_TERMS = 2    // keyword overlaps for a post to count toward a cluster

export type ArticleRow = {
  id: string
  title: string
  description: string | null
  source: string
  source_lean: number | null
  political_lean: number | null
  general_topic_id: string | null
  published_at: string | null
  created_at: string
  media: string | null
  image_mode: string
  entities: string[]
  event_terms: string[]
  evidence_summary?: string | null
  evidence_search_text?: string | null
  claims?: Array<{ claim?: string; attribution?: string; confidence?: number }>
}

type Cluster = {
  members: ArticleRow[]
  profiles: Keywords[]
  leader: Keywords
}

function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(0, Math.max(1, maxChars - 1)).trimEnd()
  const lastSpace = slice.lastIndexOf(' ')
  const cut = lastSpace >= Math.floor(maxChars * 0.6) ? slice.slice(0, lastSpace) : slice
  return `${cut.trimEnd()}…`
}

// Prefer forum-original structured evidence; fall back to the attributed
// headline when extraction was unavailable.
export function leadOf(article: ArticleRow, maxChars = 260): string {
  return truncateAtWord(article.evidence_summary || article.title, maxChars)
}

const centrality = (a: ArticleRow) => Math.abs((a.source_lean ?? 0.5) - 0.5)

// Most-centrist member, ties broken by recency — used wherever we lift
// prose, so generated blurbs skew toward the least-slanted available copy.
function mostCentral(members: ArticleRow[]): ArticleRow {
  return [...members].sort(
    (a, b) =>
      centrality(a) - centrality(b) ||
      Date.parse(b.published_at ?? b.created_at) - Date.parse(a.published_at ?? a.created_at)
  )[0]
}

const JUNK_TITLE_RE = /watch live|^watch:|^live updates|^live:|^exclusive:|^breaking:|\?$/i

function clusterTitle(members: ArticleRow[]): string {
  // Shortest reasonable headline from the most-centrist half of members
  const pool = [...members]
    .sort((a, b) => centrality(a) - centrality(b))
    .slice(0, Math.max(2, Math.ceil(members.length / 2)))
  const best = pool
    .map((m) => m.title)
    .filter((t) => t.length >= 25 && !JUNK_TITLE_RE.test(t))
    .sort((a, b) => a.length - b.length)[0]
  const title = best ?? members[0].title
  return title.length > 90 ? `${title.slice(0, 87)}…` : title
}

function spectrumSummary(members: ArticleRow[]): string {
  const bands: { label: string; test: (l: number) => boolean }[] = [
    { label: 'From the left',   test: (l) => l < 0.4 },
    { label: 'From the center', test: (l) => l >= 0.4 && l <= 0.6 },
    { label: 'From the right',  test: (l) => l > 0.6 },
  ]
  const parts: string[] = []
  for (const band of bands) {
    const inBand = members.filter((m) => band.test(m.source_lean ?? 0.5))
    if (inBand.length === 0) continue
    const pick = mostCentral(inBand)
    parts.push(`${band.label} (${pick.source}): ${leadOf(pick)}`)
  }
  return parts.join('\n\n')
}

function coverageSummary(members: ArticleRow[]): string {
  const outlets = [...new Set(members.map((member) => member.source))]
  const shown = outlets.slice(0, 4)
  const sourceList = shown.length > 1
    ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
    : shown[0]
  const more = outlets.length > shown.length
    ? `, plus ${outlets.length - shown.length} more`
    : ''
  return `${outlets.length} outlets are covering this story: ${sourceList}${more}. Open the coverage below to read each publisher's reporting.`
}

function clusterKey(top: string[]): string {
  return top
    .map((term) => term.replace(/^entity:/, ''))
    .filter((term) => !term.includes(' '))
    .slice(0, 3)
    .sort()
    .join('|')
}

const publicClusterTerms = (top: string[]) =>
  top.map((term) => term.replace(/^entity:/, ''))

function modeTopic(members: ArticleRow[]): string | null {
  const counts = new Map<string, number>()
  for (const m of members) {
    if (m.general_topic_id) counts.set(m.general_topic_id, (counts.get(m.general_topic_id) ?? 0) + 1)
  }
  let best: string | null = null
  let bestN = 0
  for (const [id, n] of counts) if (n > bestN) { best = id; bestN = n }
  return best
}

// Combined keyword profile of a cluster (sum of member profiles).
function mergedProfile(profiles: Keywords[]): Keywords {
  const terms = new Map<string, number>()
  for (const p of profiles) {
    for (const [t, w] of p.terms) terms.set(t, (terms.get(t) ?? 0) + w)
  }
  const top = [...terms.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 16)
    .map(([t]) => t)
  return { terms, top }
}

export async function clusterAndPublish(): Promise<{ clusters: number; hot: string[] }> {
  const { rows: articles } = await query(
    `SELECT a.id, a.title, a.description, a.source, a.source_lean, a.political_lean,
            a.general_topic_id, a.published_at, a.created_at,
            CASE
              WHEN a.image_mode = 'managed_thumbnail'
                THEN COALESCE(a.media_large_url, a.media_thumbnail_url, a.media_source_url)
              WHEN a.image_mode IN ('remote_no_cache', 'licensed_cache')
                THEN COALESCE(a.media, a.media_source_url)
              ELSE NULL
            END AS media,
            a.image_mode, a.entities, a.event_terms,
            e.evidence_summary, e.search_text AS evidence_search_text, e.claims
     FROM articles a
     LEFT JOIN article_evidence e ON e.article_id = a.id
     WHERE a.title IS NOT NULL AND a.scorer_version IS NOT NULL AND a.status = 'ready'
       AND a.created_at > NOW() - INTERVAL '${RECENT_DAYS} days'
     ORDER BY a.created_at DESC, a.id`
  )

  // Greedy leader clustering: newest article founds a cluster; each next
  // article joins the most-similar fixed leader above threshold or founds
  // its own. Keeping the leader fixed prevents a large cluster's vocabulary
  // from snowballing until it absorbs unrelated stories.
  const clusters: Cluster[] = []
  for (const article of articles as ArticleRow[]) {
    const profile = metadataKeywordProfile(
      article.title,
      article.entities ?? [],
      article.event_terms ?? [],
      [article.evidence_search_text ?? '', article.evidence_summary ?? '']
        .filter(Boolean)
        .join(' ')
    )
    let best: Cluster | null = null
    let bestSim = 0
    for (const c of clusters) {
      const sim = keywordSimilarity(profile, c.leader)
      if (sim > bestSim) { bestSim = sim; best = c }
    }
    if (best && bestSim >= SIM_THRESHOLD) {
      best.members.push(article)
      best.profiles.push(profile)
    } else {
      clusters.push({ members: [article], profiles: [profile], leader: profile })
    }
  }

  // Second pass: greedy growth can split one story across two clusters
  // when early members used different vocabulary. Merge clusters whose
  // FIXED top-keyword lists strongly overlap — computed pairwise on the
  // pre-merge profiles (never on merged results), so merging can't
  // snowball into one mega-cluster.
  const TOP_K = 10
  const MIN_SHARED_TOP = 5
  const parent = clusters.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < clusters.length; i++) {
    const topI = new Set(clusters[i].leader.top.slice(0, TOP_K))
    for (let j = i + 1; j < clusters.length; j++) {
      let shared = 0
      for (const t of clusters[j].leader.top.slice(0, TOP_K)) if (topI.has(t)) shared++
      if (shared >= MIN_SHARED_TOP) parent[find(j)] = find(i)
    }
  }
  const groups = new Map<number, Cluster>()
  for (let i = 0; i < clusters.length; i++) {
    const root = find(i)
    const g = groups.get(root)
    if (!g) {
      groups.set(root, clusters[i])
    } else {
      g.members.push(...clusters[i].members)
      g.profiles.push(...clusters[i].profiles)
    }
  }
  const mergedClusters = [...groups.values()].map((c) => ({ ...c, leader: mergedProfile(c.profiles) }))

  const viable = mergedClusters
    .filter((c) => c.members.length >= MIN_ARTICLES && new Set(c.members.map((m) => m.source)).size >= MIN_OUTLETS)

  // Recent posts, for volume + public opinion per cluster
  const { rows: posts } = await query(
    `SELECT id, content, hashtags, position FROM posts
     WHERE created_at > NOW() - INTERVAL '${RECENT_DAYS} days'`
  )
  const postProfiles = posts.map((p) => ({
    row: p,
    profile: extractKeywords('', `${p.content} ${(p.hashtags ?? []).join(' ')}`),
  }))

  type Scored = {
    cluster: Cluster
    key: string
    outlets: number
    postMatches: { position: number | null }[]
    score: number
  }
  const scored: Scored[] = viable.map((cluster) => {
    const outlets = new Set(cluster.members.map((m) => m.source)).size
    const postMatches = postProfiles
      .filter(({ profile }) => {
        let overlap = 0
        for (const t of cluster.leader.top) if (profile.terms.has(t)) overlap++
        return overlap >= POST_MATCH_TERMS
      })
      .map(({ row }) => ({ position: row.position }))
    // Hotness: corroboration × outlet spread, plus community chatter
    const score = cluster.members.length * Math.sqrt(outlets) + 2 * postMatches.length
    return { cluster, key: clusterKey(cluster.leader.top), outlets, postMatches, score }
  })

  const hot = scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, MAX_CLUSTERS)

  // Rebuild automatic membership from scratch. Otherwise articles retain
  // old subtopic IDs after clusters change and unrelated coverage gradually
  // accumulates on summary screens.
  await query(
    `UPDATE articles SET subtopic_id = NULL
     WHERE subtopic_id IN (
       SELECT id FROM subtopics WHERE cluster_key IS NOT NULL
     )`
  )

  const hotTitles: string[] = []
  for (const { cluster, key, postMatches, score } of hot) {
    if (!key) continue
    const positions = postMatches.map((p) => p.position).filter((p): p is number => p !== null)
    const publicPosition =
      positions.length >= 3 ? positions.reduce((a, b) => a + b, 0) / positions.length : null

    const title = clusterTitle(cluster.members)
    hotTitles.push(title)
    const upserted = await query(
      `INSERT INTO subtopics
         (general_topic_id, title, short_summary, long_summary, keywords,
          volume, public_position, image_urls, cluster_key, score,
          summary_policy_version, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (cluster_key) DO UPDATE SET
         general_topic_id = EXCLUDED.general_topic_id,
         title = EXCLUDED.title,
         short_summary = EXCLUDED.short_summary,
         long_summary = EXCLUDED.long_summary,
         keywords = EXCLUDED.keywords,
         volume = EXCLUDED.volume,
         public_position = EXCLUDED.public_position,
         image_urls = EXCLUDED.image_urls,
         score = EXCLUDED.score,
         summary_policy_version = EXCLUDED.summary_policy_version,
         updated_at = NOW()
       RETURNING id`,
      [
        modeTopic(cluster.members),
        title,
        coverageSummary(cluster.members),
        spectrumSummary(cluster.members),
        toHashtags(publicClusterTerms(cluster.leader.top), 8),
        cluster.members.length + postMatches.length,
        publicPosition,
        cluster.members.map((m) => m.media).filter(Boolean).slice(0, 5),
        key,
        score,
        RIGHTS_POLICY_VERSION,
      ]
    )
    await query(
      `UPDATE articles SET subtopic_id = $1 WHERE id = ANY($2::uuid[])`,
      [upserted.rows[0].id, cluster.members.map((m) => m.id)]
    )
  }

  // Anything not published this batch (aged out or merged away) stops
  // competing for the hot list immediately
  await query(
    `UPDATE subtopics SET score = 0
     WHERE cluster_key IS NOT NULL AND NOT (cluster_key = ANY($1::text[]))`,
    [hot.map((h) => h.key)]
  )

  console.log(`[cluster] ${articles.length} recent articles → ${viable.length} viable stories, published top ${hotTitles.length}`)
  return { clusters: viable.length, hot: hotTitles }
}
