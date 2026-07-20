// Grounding context for forumAI — deterministic retrieval over the app's
// own ingested articles. No embeddings, no external search: the same
// keyword machinery that drives hashtags and clustering ranks recent
// articles against the question. Every output here is clamped hard so the
// prompt can never balloon no matter how big the corpus gets.

import { query } from '../db'
import { extractKeywords, keywordSimilarity, type Keywords } from '../ingest/keywords'

const RECENT_DAYS = 14
const CANDIDATE_LIMIT = 400
const MAX_COVERAGE_ITEMS = 5
const MAX_PER_OUTLET = 2
const MIN_SHARED_TERMS = 2
const TITLE_CLAMP = 140
const LEAD_CLAMP = 220
const SUBJECT_CLAMP = 900
const COVERAGE_CLAMP = 2600

function clamp(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…'
}

export function leanLabel(lean: number | string | null | undefined): string {
  if (lean == null) return 'Unrated'
  const n = Number(lean)
  if (n < 0.4) return 'Left'
  if (n > 0.6) return 'Right'
  return 'Center'
}

function day(d: Date | string | null | undefined): string {
  return d ? new Date(d).toISOString().slice(0, 10) : 'undated'
}

// Words that carry meaning in a headline but are filler in a question
// ("what's happening right now with...") — never let them drive a match.
const QUESTION_FILLER = new Set([
  'happening', 'happened', 'right', 'now', 'tell', 'explain', 'going', 'current',
  'currently', 'situation', 'thoughts', 'think', 'views', 'view', 'opinion',
  'opinions', 'different', 'perspective', 'perspectives', 'sides', 'side',
  'mean', 'means', 'stance', 'debate', 'question', 'answer', 'talk', 'discuss',
  'understand', 'info', 'information', 'ask', 'asking', 'wondering', 'know',
  'thing', 'things', 'issue', 'issues', 'topic', 'topics', 'summarize', 'summary',
])

function fold(term: string): string {
  return term.endsWith('s') ? term.slice(0, -1) : term
}

// Question keywords minus filler, with naive plural folding so "tariffs"
// in a question still matches "tariff" in a headline.
function questionProfile(seedText: string): Keywords {
  const qk = extractKeywords(seedText, '')
  const terms = new Map<string, number>()
  for (const [term, w] of qk.terms) {
    if (term.includes(' ')) {
      const [a, b] = term.split(' ')
      if (QUESTION_FILLER.has(a) || QUESTION_FILLER.has(b)) continue
      terms.set(term, w)
      continue
    }
    if (QUESTION_FILLER.has(term)) continue
    terms.set(term, w)
    const variant = term.endsWith('s') ? term.slice(0, -1) : `${term}s`
    if (variant.length >= 3 && !terms.has(variant)) terms.set(variant, w)
  }
  return { terms, top: [] }
}

// Distinct shared concepts: folded so "tariff"+"tariffs" count once. A
// shared bigram is specific enough to qualify a match on its own.
function sharedConcepts(q: Keywords, article: Keywords): { roots: number; bigram: boolean } {
  const roots = new Set<string>()
  let bigram = false
  for (const term of q.terms.keys()) {
    if (!article.terms.has(term)) continue
    if (term.includes(' ')) bigram = true
    roots.add(term.split(' ').map(fold).join(' '))
  }
  return { roots: roots.size, bigram }
}

type ArticleRow = {
  id: string
  title: string | null
  source: string | null
  source_lean: number | null
  published_at: string | null
  content: string | null
}

// Top recent articles matching the seed text, one bullet line each.
// Empty string when nothing matches well enough — better no context than
// stuffing the prompt with unrelated stories.
export async function relatedCoverage(seedText: string, excludeId?: string | null): Promise<string> {
  const qk = questionProfile(seedText)
  if (qk.terms.size === 0) return ''

  const result = await query(
    `SELECT id, title, source, source_lean, published_at, content
     FROM articles
     WHERE status = 'ready' AND title IS NOT NULL
       AND COALESCE(published_at, created_at) > NOW() - INTERVAL '${RECENT_DAYS} days'
     ORDER BY published_at DESC NULLS LAST
     LIMIT ${CANDIDATE_LIMIT}`
  )

  // A short question ("tell me about Gaza") may reduce to one concept —
  // then one shared root is enough. Richer questions must share two.
  const questionRoots = new Set(
    [...qk.terms.keys()].filter((t) => !t.includes(' ')).map(fold)
  ).size
  const requiredRoots = questionRoots <= 2 ? 1 : MIN_SHARED_TERMS

  const scored = (result.rows as ArticleRow[])
    .filter((a) => a.id !== excludeId)
    .map((a) => {
      const profile = extractKeywords(a.title ?? '', a.content ?? '', 400)
      const { roots, bigram } = sharedConcepts(qk, profile)
      return { a, roots, bigram, sim: keywordSimilarity(qk, profile) }
    })
    .filter((s) => s.roots >= requiredRoots || s.bigram)
    .sort((x, y) => y.sim - x.sim)

  // Outlet cap keeps one wire-heavy story from filling every slot
  const picked: ArticleRow[] = []
  const perOutlet = new Map<string, number>()
  for (const { a } of scored) {
    const n = perOutlet.get(a.source ?? '') ?? 0
    if (n >= MAX_PER_OUTLET) continue
    perOutlet.set(a.source ?? '', n + 1)
    picked.push(a)
    if (picked.length >= MAX_COVERAGE_ITEMS) break
  }
  if (picked.length === 0) return ''

  const lines: string[] = []
  let budget = COVERAGE_CLAMP
  for (const a of picked) {
    const line = `- "${clamp(a.title ?? '', TITLE_CLAMP)}" — ${a.source} (${leanLabel(a.source_lean)}), ${day(a.published_at)}: ${clamp(a.content ?? '', LEAD_CLAMP)}`
    if (line.length + 1 > budget) break
    lines.push(line)
    budget -= line.length + 1
  }
  return lines.join('\n')
}

// The item the user is looking at when they tap "Ask forumAI" — becomes a
// pinned block in the system prompt plus seed text for coverage retrieval.
export type Subject = { block: string; seed: string }

export async function articleSubject(articleId: string): Promise<Subject | null> {
  const result = await query(
    'SELECT id, title, source, source_lean, published_at, content FROM articles WHERE id = $1',
    [articleId]
  )
  const a = result.rows[0] as ArticleRow | undefined
  if (!a) return null
  const block = [
    'The user is currently viewing this news article; unless they clearly ask about something else, treat their questions as being about it:',
    `Title: ${clamp(a.title ?? 'Untitled', TITLE_CLAMP)}`,
    `Source: ${a.source} (${leanLabel(a.source_lean)}) — published ${day(a.published_at)}`,
    `Excerpt: ${clamp(a.content ?? '', SUBJECT_CLAMP)}`,
  ].join('\n')
  return { block, seed: `${a.title ?? ''} ${(a.content ?? '').slice(0, 400)}` }
}

export async function postSubject(postId: string): Promise<Subject | null> {
  const result = await query(
    `SELECT p.content, p.created_at, p.position, p.hashtags, u.username
     FROM posts p LEFT JOIN userdata u ON u.id = p.user_id
     WHERE p.id = $1`,
    [postId]
  )
  const p = result.rows[0]
  if (!p) return null
  const tags = ((p.hashtags ?? []) as string[]).slice(0, 5).map((t) => `#${t}`).join(' ')
  const block = [
    'The user is currently viewing this community post; unless they clearly ask about something else, treat their questions as being about it:',
    `Author: ${p.username ?? 'unknown'} — posted ${day(p.created_at)}${tags ? ` — ${tags}` : ''}`,
    p.position != null
      ? `The app's bias scorer places this post ${leanLabel(p.position)} (${Number(p.position).toFixed(2)} on a 0=left…1=right scale).`
      : '',
    `Post: ${clamp(p.content ?? '', SUBJECT_CLAMP)}`,
  ]
    .filter(Boolean)
    .join('\n')
  return { block, seed: (p.content ?? '').slice(0, 400) }
}
