// ============================================================
// Deterministic feature extraction over raw article/post text.
// Same input text → same features, always. No network, no models.
// ============================================================

import {
  LEFT_FRAMING,
  RIGHT_FRAMING,
  LOADED_TERMS,
  NEUTRAL_ATTRIBUTION,
  LOADED_ATTRIBUTION,
  HEDGES,
  OPINION_MARKERS,
  POLITICAL_VOCAB,
} from './lexicons'

export type LexiconHit = { term: string; count: number }

export type TextFeatures = {
  wordCount: number
  quoteRatio: number          // share of characters inside quotation marks
  leftHits: LexiconHit[]
  rightHits: LexiconHit[]
  leftCount: number
  rightCount: number
  loadedHits: LexiconHit[]
  loadedCount: number
  neutralAttrCount: number
  loadedAttrCount: number
  hedgeCount: number
  opinionMarkerCount: number  // counted outside quotes only
  firstPersonCount: number    // counted outside quotes only
  exclamations: number
  questions: number
  numberDensity: number       // numeric tokens per 100 words
  politicalCount: number
}

// Compile a lexicon entry to a word-boundary regex. Trailing '~'
// permits common inflection suffixes (s, es, ed, ing).
function compile(entry: string): RegExp {
  const inflect = entry.endsWith('~')
  const base = (inflect ? entry.slice(0, -1) : entry)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/ /g, '\\s+')
  return new RegExp(`\\b${base}${inflect ? '(?:s|es|ed|ing)?' : ''}\\b`, 'gi')
}

type Compiled = { term: string; re: RegExp }
const compileAll = (list: string[]): Compiled[] =>
  list.map((term) => ({ term: term.replace(/~$/, ''), re: compile(term) }))

// Compiled once at module load — part of the versioned scorer.
const LEX = {
  left: compileAll(LEFT_FRAMING),
  right: compileAll(RIGHT_FRAMING),
  loaded: compileAll(LOADED_TERMS),
  neutralAttr: compileAll(NEUTRAL_ATTRIBUTION),
  loadedAttr: compileAll(LOADED_ATTRIBUTION),
  hedges: compileAll(HEDGES),
  opinion: compileAll(OPINION_MARKERS),
  political: compileAll(POLITICAL_VOCAB),
}

function countHits(text: string, lex: Compiled[], capPerTerm = Infinity): LexiconHit[] {
  const hits: LexiconHit[] = []
  for (const { term, re } of lex) {
    re.lastIndex = 0
    const count = Math.min((text.match(re) ?? []).length, capPerTerm)
    if (count > 0) hits.push({ term, count })
  }
  return hits
}

const total = (hits: LexiconHit[]) => hits.reduce((n, h) => n + h.count, 0)

// Strip quoted spans so quoted speakers' words don't count as the
// author's own opinion. Handles straight and curly double quotes.
function splitQuotes(text: string): { unquoted: string; quoteRatio: number } {
  const quoteRe = /["“]([^"“”]{2,600}?)["”]/g
  let quotedChars = 0
  const unquoted = text.replace(quoteRe, (m) => {
    quotedChars += m.length
    return ' '
  })
  return {
    unquoted,
    quoteRatio: text.length > 0 ? quotedChars / text.length : 0,
  }
}

export function extractFeatures(text: string): TextFeatures {
  const clean = text.replace(/\s+/g, ' ').trim()
  const { unquoted, quoteRatio } = splitQuotes(clean)

  const words = clean.match(/[A-Za-z'’-]+/g) ?? []
  const wordCount = words.length
  const numbers = clean.match(/\b\d[\d,.%]*\b/g) ?? []

  // Framing terms are counted outside quotations only — a quoted (or
  // mocked) opponent's vocabulary is not the author's framing choice —
  // and capped per term so one repeated phrase can't dominate the score.
  const leftHits = countHits(unquoted, LEX.left, 3)
  const rightHits = countHits(unquoted, LEX.right, 3)
  const loadedHits = countHits(unquoted, LEX.loaded)

  // First person: "I"/"my"/"we"/"our" outside quotes. "US"/"us" is
  // excluded — too ambiguous with the country in political text.
  const firstPersonCount = (unquoted.match(/\b(I|I'm|I've|my|mine|we|we're|our|ours)\b/g) ?? []).length

  return {
    wordCount,
    quoteRatio,
    leftHits,
    rightHits,
    leftCount: total(leftHits),
    rightCount: total(rightHits),
    loadedHits,
    loadedCount: total(loadedHits),
    neutralAttrCount: total(countHits(clean, LEX.neutralAttr)),
    loadedAttrCount: total(countHits(unquoted, LEX.loadedAttr)),
    hedgeCount: total(countHits(unquoted, LEX.hedges)),
    opinionMarkerCount: total(countHits(unquoted, LEX.opinion)),
    firstPersonCount,
    exclamations: (unquoted.match(/!/g) ?? []).length,
    questions: (unquoted.match(/\?/g) ?? []).length,
    numberDensity: wordCount > 0 ? (numbers.length / wordCount) * 100 : 0,
    politicalCount: total(countHits(clean, LEX.political)),
  }
}
