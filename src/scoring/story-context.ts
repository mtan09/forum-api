// ============================================================
// Stage B2 — per-story coalition mapping for claims about people.
//
// "I support Blanche's confirmation" is right-leaning because Trump
// nominated him. That fact cannot live in a committed table: it is true
// for a few weeks, and a table of who-is-politically-what would be
// stale before the next reshuffle.
//
// It does not need to. A person needs no permanent political identity,
// only one for the story being discussed — which lasts exactly as long
// as posts about it do. And the press states it continuously:
//
//   Republicans clear Todd Blanche for top US Justice Department role
//   Trump posts video targeting Murkowski over vote against Blanche
//
// So the mapping is derived from headlines, refreshed whenever ingest
// runs, and expires with the story. Nothing to maintain.
//
// DETERMINISM. scorePost() stays synchronous and pure: the caller loads
// a StoryContext and passes it in. What was resolved is written into
// position_signals, so `rescore:posts` replays the judgement made at the
// time rather than silently re-deriving it against a newer news cycle.
// The story layer is time-stamped evidence, not a timeless rule.
// ============================================================

import { query } from '../db'
import type { Side } from './direction'

export type StoryContext = {
  clusterKey: string
  storyTitle: string
  asOf: string
  /** Action key → the coalition that is pushing for it in this story. */
  supports: Record<string, Side>
}

// --- Coalition actors ------------------------------------------------
const ACTORS: [Side, RegExp][] = [
  ['right', /\b(?:republicans?|GOP|Trump|conservatives?|MAGA)\b/i],
  ['left', /\b(?:democrats?|progressives?|liberals?|Biden)\b/i],
]

// Verbs that show an actor driving an action forward.
const DRIVING = /\b(?:nominat\w*|pick(?:s|ed)?|tap(?:s|ped)?|appoint\w*|clear(?:s|ed)?|advanc\w*|confirm\w*|back(?:s|ed)?|push(?:es|ed)?|endors\w*|approv\w*|move(?:s|d)? ahead)\b/i

// Verbs that show an actor resisting it.
const RESISTING = /\b(?:oppos\w*|block(?:s|ed)?|reject\w*|stall\w*|hold(?:s|ing)? up|against|derail\w*|sink(?:s)?|withdraw\w*)\b/i

// Nomination and appointment are structural rather than attitudinal — whoever
// nominates plainly wants the confirmation — so they weigh more than a
// reported opinion.
const STRUCTURAL = /\b(?:nominat\w*|appoint\w*|pick(?:s|ed)?|tap(?:s|ped)?)\b/i

const ACTIONS: [action: string, re: RegExp][] = [
  ['confirmation', /\b(?:confirmation|confirm\w*|nomination|nominee|nominat\w*)\b/i],
  ['ethics-probe', /\bethics\b/i],
  ['investigation', /\b(?:investigat\w*|subpoena\w*|indict\w*|contempt|probe)\b/i],
  ['impeachment', /\bimpeach\w*/i],
  ['resignation', /\b(?:resign\w*|step(?:ping|s)? down|ouster|oust\w*)\b/i],
]

const other = (side: Side): Side => (side === 'left' ? 'right' : 'left')

/**
 * Tally which coalition is pushing each action across a story's headlines.
 *
 * Requires a clear margin rather than unanimity. Defections are precisely
 * what gets written up — "Second GOP Senator Comes Out Against Blanche
 * Confirmation" is a headline *because* it is atypical — so demanding zero
 * contradicting evidence would suppress nearly every real story. A 2:1
 * margin with at least 2 net weight keeps the obvious cases and drops the
 * genuinely split ones.
 */
export function deriveSupports(titles: string[]): Record<string, Side> {
  const score = new Map<string, { left: number; right: number }>()

  for (const title of titles) {
    const actor = ACTORS.find(([, re]) => re.test(title))
    if (!actor) continue
    const [side] = actor

    const drives = DRIVING.test(title)
    const resists = RESISTING.test(title)
    // A headline containing both is ambiguous about who is doing which.
    if (drives === resists) continue

    for (const [action, re] of ACTIONS) {
      if (!re.test(title)) continue
      const weight = drives && STRUCTURAL.test(title) ? 2 : 1
      const beneficiary = drives ? side : other(side)
      const bucket = score.get(action) ?? { left: 0, right: 0 }
      // Resisting is weaker evidence for the opposite side than driving is
      // for your own: a senator blocking a nominee does not mean the other
      // party wants them.
      bucket[beneficiary] += drives ? weight : 0.5
      score.set(action, bucket)
      break
    }
  }

  const supports: Record<string, Side> = {}
  for (const [action, { left, right }] of score) {
    const [hi, lo, side] = left >= right
      ? [left, right, 'left' as Side]
      : [right, left, 'right' as Side]
    if (hi - lo >= 2 && hi >= lo * 2) supports[action] = side
  }
  return supports
}

/**
 * Find the story a post is about and derive its coalition map.
 *
 * Matches against `subtopics.keywords` — the hashtags clustering already
 * derived — rather than re-running the clusterer. Returns null when the post
 * matches no live story, which leaves actor claims unresolved rather than
 * guessed.
 */
export async function loadStoryContext(text: string): Promise<StoryContext | null> {
  const terms = new Set(
    text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []
  )
  if (terms.size === 0) return null

  const { rows } = await query(
    `SELECT s.id, s.title, s.cluster_key, s.keywords
     FROM subtopics s
     WHERE s.cluster_key IS NOT NULL AND s.updated_at > NOW() - INTERVAL '14 days'
     ORDER BY s.score DESC NULLS LAST
     LIMIT 60`
  )

  let best: { id: string; title: string; key: string; overlap: number } | null = null
  for (const row of rows as any[]) {
    const keywords: string[] = row.keywords ?? []
    const overlap = keywords.filter((k) => terms.has(String(k).toLowerCase())).length
    if (overlap >= 2 && (!best || overlap > best.overlap)) {
      best = { id: row.id, title: row.title, key: row.cluster_key, overlap }
    }
  }
  if (!best) return null

  const { rows: titles } = await query(
    `SELECT title FROM articles WHERE subtopic_id = $1 AND status = 'ready' LIMIT 200`,
    [best.id]
  )
  const supports = deriveSupports((titles as any[]).map((r) => String(r.title ?? '')))
  if (Object.keys(supports).length === 0) return null

  return {
    clusterKey: best.key,
    storyTitle: best.title,
    asOf: new Date().toISOString().slice(0, 10),
    supports,
  }
}

/**
 * Resolve an actor claim. `supports[action]` is the coalition pushing for it;
 * a post opposing that action therefore belongs to the other side.
 */
export function resolveActor(
  action: string,
  polarity: 'for' | 'against',
  story: StoryContext | null | undefined
): { side: Side } | { side: null; reason: 'unmapped-actor' } {
  const backing = story?.supports?.[action]
  if (!backing) return { side: null, reason: 'unmapped-actor' }
  return { side: polarity === 'for' ? backing : other(backing) }
}
