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
import { detectClaims, netDirection, type Claim } from './claims'
import { resolveTopic, type Side } from './direction'
import { resolveActor, type StoryContext } from './story-context'

// Bump on ANY change to lexicons, weights, or thresholds, then run
// `npm run rescore` so stored scores stay comparable.
// 1.1.0: framing counted outside quotes only, capped at 3 per term
// 1.2.0: posts were always placed; neutral and unrecognized text sat at 0.5
// 2.0.0: posts combine partisan framing with a transparent policy-stance
//        ontology; text with no directional evidence is left unclassified
// 3.0.0: posts add compositional policy rules plus a deterministic, local
//        prototype fallback and retain evidence/method receipts for each hit
// 4.0.0: posts become a three-stage pipeline — claim extraction (claims.ts),
//        coalition mapping (direction.ts + story-context.ts), then
//        calibration. Direction is no longer welded into each matcher, so
//        "I oppose X" flips instead of being discarded, framing vocabulary
//        can no longer set a direction on its own, and every unplaced post
//        records why it was unplaced.
export const ARTICLE_SCORER_VERSION = 'stance-2.0.0'
export const POST_SCORER_VERSION = 'claims-4.0.0'
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

/** Why a post was left unplaced. The first three are correct and permanent;
 *  the last two are coverage gaps, and separating them is the point. */
export type NullReason =
  | 'no-claim'        // no position stated — observation, question, refusal
  | 'contested'       // deliberate: the left/right mapping has genuinely moved
  | 'unmapped-topic'  // real ask, topic absent from the table
  | 'unmapped-actor'  // claim about a person the headlines don't disambiguate

export type PostScore = {
  position: number | null    // null = no directional evidence, not "centrist"
  confidence: number
  signals: string[]
  scorer_version: string
  null_reason?: NullReason
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
// Three stages. Stage A (claims.ts) says what the author wants, with no
// politics in it. Stage B (direction.ts for topics, story-context.ts for
// named people) says which coalition wants that. Stage C, below, is
// arithmetic.
//
// Posts get their own constants. The article path reaches full strength at
// six framing hits, which a 40-word post cannot do — one hit yielded ±0.05
// and landed exactly on the centre/right band boundary.

/** Claims needed for full strength. Two, not the article path's six. */
const FULL_STRENGTH_CLAIMS = 2
/** How far resolved claims can move the position. */
const MAX_CLAIM_SHIFT = 0.28
/**
 * Framing vocabulary is an intensifier, never a placement. It marks whose
 * vocabulary the author is using, which inverts the moment someone argues
 * against a thing they named neutrally — "the Affordable Care Act should be
 * repealed" used to score left purely on the name.
 */
const MAX_FRAMING_BOOST = 0.06
const FRAMING_FULL_STRENGTH_POST = 2

function describeClaims(claims: Claim[], resolved: Map<Claim, Side>): string[] {
  return claims.flatMap((claim) => {
    const side = resolved.get(claim)
    const net = netDirection(claim)
    return [
      `claim:"${claim.topic} · ${net}"×1`,
      `claim-meta:${JSON.stringify({
        kind: claim.kind,
        topic: claim.topic,
        ...(claim.target ? { target: claim.target } : {}),
        stated: claim.direction,
        polarity: claim.polarity,
        net,
        side: side ?? null,
        method: claim.source ?? claim.method,
        confidence: Number(claim.confidence.toFixed(2)),
        evidence: claim.evidence,
      })}`,
    ]
  })
}

export function scorePost(content: string, story?: StoryContext | null): PostScore {
  const f = extractFeatures(content)

  // -- Stage A ---------------------------------------------------------
  const claims = detectClaims(content)

  // -- Stage B ---------------------------------------------------------
  const resolved = new Map<Claim, Side>()
  const reasons: NullReason[] = []
  let contestedWeight = 0
  let resolvedWeight = 0
  for (const claim of claims) {
    const outcome = claim.kind === 'actor'
      ? resolveActor(claim.topic, claim.polarity, story)
      : resolveTopic(claim.topic, netDirection(claim))
    if (outcome.side) {
      resolved.set(claim, outcome.side)
      resolvedWeight = Math.max(resolvedWeight, claim.weight)
    } else {
      reasons.push(outcome.reason)
      if (outcome.reason === 'contested') {
        contestedWeight = Math.max(contestedWeight, claim.weight)
      }
    }
  }

  // A contested claim suppresses placement when it is the post's dominant
  // one. "Tariffs on Chinese steel protect American workers" also trips a
  // worker-protection rule; placing it left on that secondary signal is the
  // original defect in miniature — reading a coalition off wording while
  // ignoring the position actually being argued. Ties suppress, because a
  // wrong placement costs more than a blank one.
  if (contestedWeight >= resolvedWeight && contestedWeight > 0) resolved.clear()

  // -- Stage C ---------------------------------------------------------
  let left = 0
  let right = 0
  let confidenceSum = 0
  for (const [claim, side] of resolved) {
    if (side === 'left') left += claim.weight
    else right += claim.weight
    confidenceSum += claim.confidence
  }
  const claimEvidence = left + right
  const claimNet = claimEvidence > 0 ? (right - left) / claimEvidence : 0
  const claimStrength = Math.min(claimEvidence / (FULL_STRENGTH_CLAIMS * 1.8), 1)
  const claimConfidence = resolved.size > 0 ? confidenceSum / resolved.size : 0

  const framingEvidence = f.leftCount + f.rightCount
  const framingNet = framingEvidence > 0
    ? (f.rightCount - f.leftCount) / framingEvidence
    : 0
  const framingStrength = Math.min(framingEvidence / FRAMING_FULL_STRENGTH_POST, 1)

  // Framing only participates once a claim has established a placement.
  const placed = resolved.size > 0
  const shift = Math.max(-0.36, Math.min(0.36,
    claimNet * claimStrength * MAX_CLAIM_SHIFT +
    (placed ? framingNet * framingStrength * MAX_FRAMING_BOOST : 0)
  ))

  const position = placed ? clamp01(0.5 + shift) : null

  // The reason a post is blank is the diagnostic that did not exist before:
  // "recognised nothing" and "recognised it but has no mapping" used to be
  // indistinguishable, so there was no way to know where effort should go.
  const nullReason: NullReason | undefined = placed
    ? undefined
    : reasons.find((r) => r === 'contested')
      ?? reasons.find((r) => r === 'unmapped-actor')
      ?? reasons.find((r) => r === 'unmapped-topic')
      ?? 'no-claim'

  const confidence = clamp01(
    0.12 +
    0.48 * claimStrength * (0.7 + 0.3 * claimConfidence) +
    0.12 * (placed ? framingStrength : 0) +
    0.15 * Math.min(f.wordCount / 120, 1) +
    0.1 * Math.min(f.politicalCount / 3, 1)
  )

  const signals = [
    `scorer:${POST_SCORER_VERSION}`,
    'classifier:claims-pipeline',
    `confidence:${confidence.toFixed(2)}`,
    ...(nullReason ? [`null-reason:${nullReason}`] : []),
    // Story mappings are time-stamped evidence, not timeless rules. Recording
    // the cluster and date is what lets rescore replay the judgement made at
    // score time instead of re-deriving against a newer news cycle.
    ...(story && claims.some((c) => c.kind === 'actor')
      ? [`story:${JSON.stringify({ cluster: story.clusterKey, asOf: story.asOf, supports: story.supports })}`]
      : []),
    ...describeClaims(claims, resolved),
    ...describeHits('left', f.leftHits),
    ...describeHits('right', f.rightHits),
    ...describeHits('loaded', f.loadedHits),
  ]

  return {
    position: position == null ? null : Number(position.toFixed(3)),
    confidence: Number(confidence.toFixed(3)),
    signals,
    scorer_version: POST_SCORER_VERSION,
    ...(nullReason ? { null_reason: nullReason } : {}),
  }
}
