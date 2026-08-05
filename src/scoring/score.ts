// ============================================================
// Deterministic bias scorer.
//
// Model, in one paragraph: an article's lean starts at its outlet's
// published lean rating (the "source prior", see ingest/sources.ts)
// and is nudged left/right by partisan framing vocabulary actually
// present in the text, capped at ±MAX_TEXT_SHIFT. A separate
// subjectivity score — loaded language, first person, opinion markers,
// quote density — classifies the piece as reporting/analysis/opinion
// BEFORE lean is interpreted: straight reporting keeps only a soft
// source-lean placement in the UI. Every score records the signals
// that produced it (articles.lean_signals / posts.position_signals)
// and the scorer version, so any score can be explained and any
// article re-scored after a lexicon change (`npm run rescore`).
//
// Scale convention: 0 = left, 1 = right, 0.5 = center.
// ============================================================

import { extractFeatures, type TextFeatures } from './features'
import { detectStances, type StanceHit } from './stances'

// Bump on ANY change to lexicons, weights, or thresholds, then run
// `npm run rescore` so stored scores stay comparable.
// 1.1.0: framing counted outside quotes only, capped at 3 per term
// 1.2.0: posts were always placed; neutral and unrecognized text sat at 0.5
// 2.0.0: posts combine partisan framing with a transparent policy-stance
//        ontology; text with no directional evidence is left unclassified
// 3.0.0: posts add compositional policy rules plus a deterministic, local
//        prototype fallback and retain evidence/method receipts for each hit
export const ARTICLE_SCORER_VERSION = 'stance-2.0.0'
export const POST_SCORER_VERSION = 'stance-3.0.0'
// Backward-compatible export used by post-scoring scripts and tests.
export const SCORER_VERSION = POST_SCORER_VERSION

export type ContentType = 'news_report' | 'opinion' | 'analysis' | 'factual_report'

export type ArticleScore = {
  political_lean: number
  lean_confidence: number
  political_relevance: number
  content_type: ContentType
  lean_signals: string[]
  scorer_version: string
}

export type PostScore = {
  position: number | null    // null = no directional evidence, not "centrist"
  confidence: number
  signals: string[]
  scorer_version: string
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

// How far article text can move the score away from the source prior.
const MAX_TEXT_SHIFT = 0.25
// Framing hits needed for the text signal to reach full strength.
const FULL_STRENGTH_HITS = 6

// --- Subjectivity: is the author editorializing? ----------------
// Densities are per 100 words; weights are fixed constants of the
// scorer version. Wire copy typically lands < 0.2, op-eds > 0.55.
export function subjectivity(f: TextFeatures): number {
  if (f.wordCount === 0) return 0
  const per100 = (n: number) => (n / f.wordCount) * 100

  const attrTotal = f.neutralAttrCount + f.loadedAttrCount
  const loadedAttrShare = attrTotal > 0 ? f.loadedAttrCount / attrTotal : 0

  const s =
    0.28 * Math.min(per100(f.loadedCount) / 1.5, 1) +
    0.22 * Math.min(per100(f.firstPersonCount) / 2.5, 1) +
    0.20 * Math.min(per100(f.opinionMarkerCount) / 0.6, 1) +
    0.12 * loadedAttrShare +
    0.08 * Math.min(per100(f.hedgeCount) / 2.5, 1) +
    0.05 * Math.min(per100(f.exclamations + f.questions) / 1, 1) -
    0.20 * Math.min(f.quoteRatio / 0.25, 1) -
    0.06 * Math.min(f.numberDensity / 5, 1)

  return clamp01(s)
}

// --- Content type -------------------------------------------------
// URL/section markers are near-ground-truth (outlets label their own
// opinion sections), so they win outright; text subjectivity decides
// the rest.
const OPINION_PATH = /\/(opinion|opinions|op-ed|oped|commentary|editorial|editorials|perspective|perspectives|voices|column|columns|blogs)(\/|$)/i

export function classifyContentType(
  subj: number,
  f: TextFeatures,
  url?: string,
  categories: string[] = []
): { type: ContentType; reason: string } {
  if (url && OPINION_PATH.test(new URL(url, 'https://x.invalid').pathname)) {
    return { type: 'opinion', reason: 'url-section' }
  }
  if (categories.some((c) => /opinion|commentary|editorial|op-ed/i.test(c))) {
    return { type: 'opinion', reason: 'feed-category' }
  }
  if (subj >= 0.55) return { type: 'opinion', reason: `subjectivity=${subj.toFixed(2)}` }
  if (subj >= 0.30) return { type: 'analysis', reason: `subjectivity=${subj.toFixed(2)}` }
  // Very dry + heavily sourced (quotes or figures) = wire-style factual report
  if (subj <= 0.12 && (f.quoteRatio >= 0.12 || f.numberDensity >= 2.5)) {
    return { type: 'factual_report', reason: `subjectivity=${subj.toFixed(2)},sourced` }
  }
  return { type: 'news_report', reason: `subjectivity=${subj.toFixed(2)}` }
}

// --- Lean ----------------------------------------------------------
// net direction ∈ [-1, 1] from framing hits; strength scales with how
// much evidence there is, so one stray phrase barely moves anything.
function textSignal(f: TextFeatures): { net: number; strength: number } {
  const evidence = f.leftCount + f.rightCount
  if (evidence === 0) return { net: 0, strength: 0 }
  return {
    net: (f.rightCount - f.leftCount) / evidence,
    strength: Math.min(evidence / FULL_STRENGTH_HITS, 1),
  }
}

function describeHits(prefix: 'left' | 'right' | 'loaded', hits: TextFeatures['leftHits']): string[] {
  return hits
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((h) => `${prefix}:"${h.term}"×${h.count}`)
}

function describeStances(hits: StanceHit[]): string[] {
  return hits.flatMap((hit) => [
    `stance-${hit.side}:"${hit.issue} · ${hit.label}"×1`,
    `stance-meta:${JSON.stringify({
      side: hit.side,
      issue: hit.issue,
      position: hit.label,
      method: hit.method,
      confidence: Number(hit.confidence.toFixed(2)),
      evidence: hit.evidence,
    })}`,
  ])
}

export function scoreArticle(input: {
  title: string
  content: string
  url?: string
  sourcePrior?: number   // outlet lean from sources.ts; undefined = unknown outlet
  categories?: string[]  // RSS category tags, for opinion detection
}): ArticleScore {
  // Title counts twice: framing choices in headlines are deliberate.
  const text = `${input.title}. ${input.title}. ${input.content}`
  const f = extractFeatures(text)
  const subj = subjectivity(f)
  const { type, reason } = classifyContentType(subj, f, input.url, input.categories)
  const { net, strength } = textSignal(f)

  const priorKnown = input.sourcePrior !== undefined
  const prior = input.sourcePrior ?? 0.5
  const lean = clamp01(prior + net * strength * MAX_TEXT_SHIFT)

  const confidence = clamp01(
    (priorKnown ? 0.4 : 0.1) +
    0.35 * strength +
    0.15 * Math.min(f.wordCount / 1200, 1) +
    (type === 'opinion' ? 0.05 : 0)
  )

  const relevance = clamp01(
    0.7 * Math.min(f.politicalCount / 8, 1) +
    0.3 * Math.min((f.leftCount + f.rightCount) / 3, 1)
  )

  const signals = [
    `scorer:${ARTICLE_SCORER_VERSION}`,
    `prior:${priorKnown ? prior.toFixed(2) : 'unknown(0.50)'}`,
    `type:${type}(${reason})`,
    `subjectivity:${subj.toFixed(2)}`,
    `quotes:${Math.round(f.quoteRatio * 100)}%`,
    ...describeHits('left', f.leftHits),
    ...describeHits('right', f.rightHits),
    ...describeHits('loaded', f.loadedHits),
  ]

  return {
    political_lean: Number(lean.toFixed(3)),
    lean_confidence: Number(confidence.toFixed(3)),
    political_relevance: Number(relevance.toFixed(3)),
    content_type: type,
    lean_signals: signals,
    scorer_version: ARTICLE_SCORER_VERSION,
  }
}

// --- Posts ----------------------------------------------------------
// No outlet prior exists for a user post, so the text carries all the
// weight. Partisan framing captures word choice; policy stances capture
// propositions expressed without slogans. Text without directional evidence
// remains unclassified instead of being mislabeled as centrist.
export function scorePost(content: string): PostScore {
  const f = extractFeatures(content)
  const framing = textSignal(f)
  const stances = detectStances(content)
  const stanceLeft = stances
    .filter((hit) => hit.side === 'left')
    .reduce((sum, hit) => sum + hit.weight, 0)
  const stanceRight = stances
    .filter((hit) => hit.side === 'right')
    .reduce((sum, hit) => sum + hit.weight, 0)
  const stanceEvidence = stanceLeft + stanceRight
  const stanceNet = stanceEvidence > 0
    ? (stanceRight - stanceLeft) / stanceEvidence
    : 0
  const stanceStrength = Math.min(stanceEvidence / 4, 1)
  const stanceConfidence = stances.length > 0
    ? stances.reduce((sum, hit) => sum + hit.confidence, 0) / stances.length
    : 0

  // Framing is a softer signal than an explicit policy stance. The combined
  // movement is capped so even highly partisan language stays on the scale.
  const shift = Math.max(-0.45, Math.min(0.45,
    framing.net * framing.strength * 0.30 +
    stanceNet * stanceStrength * 0.35
  ))
  const evidence = f.leftCount + f.rightCount + stanceEvidence

  const position = evidence > 0 ? clamp01(0.5 + shift) : null
  const confidence = clamp01(
    0.1 +
    0.25 * framing.strength +
    0.4 * stanceStrength * (0.7 + 0.3 * stanceConfidence) +
    0.15 * Math.min(f.wordCount / 120, 1) +
    0.1 * Math.min(f.politicalCount / 3, 1)
  )

  const signals = [
    `scorer:${POST_SCORER_VERSION}`,
    'classifier:hybrid-local',
    `confidence:${confidence.toFixed(2)}`,
    ...describeStances(stances),
    ...describeHits('left', f.leftHits),
    ...describeHits('right', f.rightHits),
    ...describeHits('loaded', f.loadedHits),
  ]

  return {
    position: position == null ? null : Number(position.toFixed(3)),
    confidence: Number(confidence.toFixed(3)),
    signals,
    scorer_version: POST_SCORER_VERSION,
  }
}
