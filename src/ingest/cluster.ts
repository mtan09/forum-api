// ============================================================
// Story clustering → auto-generated subtopics ("hot topics").
//
// Replaces hand-written subtopics entirely. Deterministic, no LLM:
//  1. Take recent scored articles (RECENT_DAYS window).
//  2. Greedy leader clustering on keyword-profile similarity.
//  3. Keep clusters with enough articles from enough distinct outlets.
//  4. Generate the blurb EXTRACTIVELY — title and summaries are real
//     sentences lifted from member articles (preferring outlets nearest
//     the center), with the long summary quoting one lead per spectrum
//     band ("From the left/center/right: ...").
//  5. Match recent user posts to clusters by keyword/hashtag overlap;
//     their scored positions become the cluster's public_position.
//  6. Upsert into subtopics by cluster_key; stale clusters age out of
//     the hot list by score/updated_at, and articles get subtopic_id.
//
// Runs after every ingest pass and via `npm run cluster`.
// ============================================================

import { query } from '../db'
import { looksLikeVideoPlaylistChrome } from './content-quality'
import { extractKeywords, keywordSimilarity, toHashtags, type Keywords } from './keywords'

const RECENT_DAYS = 7
const SIM_THRESHOLD = 0.3     // join a cluster at ≥ this similarity to its leader
const MIN_ARTICLES = 3        // a story needs corroboration...
const MIN_OUTLETS = 2         // ...from more than one outlet
const MAX_CLUSTERS = 12
const POST_MATCH_TERMS = 2    // keyword overlaps for a post to count toward a cluster

export type ArticleRow = {
  id: string
  title: string
  content: string
  source: string
  source_lean: number | null
  political_lean: number | null
  general_topic_id: string | null
  published_at: string | null
  created_at: string
  media: string | null
}

type Cluster = {
  members: ArticleRow[]
  profiles: Keywords[]
  leader: Keywords
}

// Site chrome and newsletter prompts that survive text extraction and
// must never end up in a blurb.
const JUNK_SENTENCE_RE = /skip to content|sign up|newsletter|your feedback|subscribe|advertisem|getty images|read more|continue reading|min read|^close\b|updated on \w+|published on \w+|^politics\b|watch live|^live updates|now playing|\bup next\b/i

// Protect abbreviations ("U.S.", "Sen.") from the sentence splitter.
const shieldDots = (text: string): string =>
  text
    .replace(/\b([A-Z])\./g, '$1․')
    .replace(/\b(Mr|Mrs|Ms|Dr|Sen|Rep|Gov|Lt|Gen|Col|St|No|vs|Jr|Sr|Inc|Corp)\./g, '$1․')
const unshieldDots = (text: string): string => text.replace(/․/g, '.')

function sentenceSplit(text: string): string[] {
  const shielded = shieldDots(text)
  return (shielded.match(/[^.!?]+[.!?]+(?:["”’]|\s|$)/g) ?? [shielded])
    .map((s) => unshieldDots(s).trim())
    .filter(Boolean)
}

function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(0, Math.max(1, maxChars - 1)).trimEnd()
  const lastSpace = slice.lastIndexOf(' ')
  const cut = lastSpace >= Math.floor(maxChars * 0.6) ? slice.slice(0, lastSpace) : slice
  return `${cut.trimEnd()}…`
}

// First 1–2 clean sentences, cut at a sentence boundary near maxChars.
// The final hard cap also handles pages with one giant punctuation-free
// block of navigation or video-player text.
export function leadOf(article: ArticleRow, maxChars = 260): string {
  if (looksLikeVideoPlaylistChrome(article.content)) {
    return truncateAtWord(article.title, maxChars)
  }
  const sentences = sentenceSplit(article.content)
    .filter((s) => s.length >= 40 && !JUNK_SENTENCE_RE.test(s))
  let out = ''
  for (const s of sentences) {
    if (!out && s.length > maxChars) {
      out = truncateAtWord(s, maxChars)
      break
    }
    if (out && (out + ' ' + s).length > maxChars) break
    out = out ? `${out} ${s}` : s
    if (out.length >= maxChars * 0.6) break
  }
  return truncateAtWord(out || article.title, maxChars)
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

function clusterKey(top: string[]): string {
  return top.filter((t) => !t.includes(' ')).slice(0, 3).sort().join('|')
}

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
    `SELECT id, title, content, source, source_lean, political_lean,
            general_topic_id, published_at, created_at, media
     FROM articles
     WHERE content IS NOT NULL AND scorer_version IS NOT NULL
       AND created_at > NOW() - INTERVAL '${RECENT_DAYS} days'
     ORDER BY created_at DESC, id`
  )

  // Greedy leader clustering: newest article founds a cluster; each next
  // article joins the most-similar fixed leader above threshold or founds
  // its own. Keeping the leader fixed prevents a large cluster's vocabulary
  // from snowballing until it absorbs unrelated stories.
  const clusters: Cluster[] = []
  for (const article of articles as ArticleRow[]) {
    const profileContent = looksLikeVideoPlaylistChrome(article.content)
      ? article.title
      : article.content
    const profile = extractKeywords(article.title, profileContent)
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
          volume, public_position, image_urls, cluster_key, score, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
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
         updated_at = NOW()
       RETURNING id`,
      [
        modeTopic(cluster.members),
        title,
        leadOf(mostCentral(cluster.members), 180),
        spectrumSummary(cluster.members),
        toHashtags(cluster.leader.top, 8),
        cluster.members.length + postMatches.length,
        publicPosition,
        cluster.members.map((m) => m.media).filter(Boolean).slice(0, 5),
        key,
        score,
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
