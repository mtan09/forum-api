// ============================================================
// Shared text-matching primitives for the scorer.
//
// These were duplicated across features.ts and stances.ts. Claim
// extraction needs the same behaviour, and three copies of a quote
// stripper is two too many — a fix applied to one and not the others
// is how "tariff" ended up matching while "tariffs" did not.
// ============================================================

// Compile a lexicon entry to a word-boundary regex. Trailing '~' permits
// common inflection suffixes. Every term list in the scorer uses this
// convention; bypassing it is the single easiest way to write a pattern
// that silently misses the plural.
export function compile(entry: string, flags = 'i'): RegExp {
  const inflect = entry.endsWith('~')
  const base = (inflect ? entry.slice(0, -1) : entry)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // A space in a term matches a hyphen too, so "school choice" also reads
    // "school-choice". Writers hyphenate compounds unpredictably and a term
    // list cannot enumerate both spellings of every entry.
    .replace(/ /g, '[\\s-]+')
  return new RegExp(`\\b${base}${inflect ? '(?:s|es|ed|ing|d)?' : ''}\\b`, flags)
}

export type Compiled = { term: string; re: RegExp }

export const compileAll = (list: string[]): Compiled[] =>
  list.map((term) => ({ term: term.replace(/~$/, ''), re: compile(term) }))

/** First entry in `lex` that appears in `text`, with its match. */
export function firstHit(text: string, lex: Compiled[]): { term: string; match: RegExpMatchArray } | null {
  for (const { term, re } of lex) {
    const match = text.match(re)
    if (match) return { term, match }
  }
  return null
}

/** Drop quoted spans — a quoted speaker's words are not the author's position. */
export function stripQuotes(text: string): string {
  return text.replace(/["“]([^"“”]{2,600}?)["”]/g, ' ')
}

export function normalize(text: string): string {
  return stripQuotes(text.replace(/\s+/g, ' ').trim())
}

/**
 * Split into clauses. Sentence terminators plus dashes and colons, which in
 * post-length text usually separate an assertion from its elaboration.
 */
export function clauses(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\s+[—–]\s+|\s+-\s+|:\s+/)
    .map((c) => c.trim())
    .filter(Boolean)
}

/** Text between the start of the enclosing clause and the match. */
export function beforeMatch(value: string, match: RegExpMatchArray): string {
  const index = match.index ?? 0
  const clauseStart = Math.max(
    value.lastIndexOf('.', index - 1),
    value.lastIndexOf('?', index - 1),
    value.lastIndexOf('!', index - 1),
    value.lastIndexOf(';', index - 1),
    value.lastIndexOf(',', index - 1)
  )
  return value.slice(clauseStart + 1, index)
}

export function snippet(value: string, match: RegExpMatchArray | null): string {
  if (!match || match.index == null) return value.slice(0, 150).trim()
  const start = Math.max(0, match.index - 45)
  const end = Math.min(value.length, match.index + match[0].length + 65)
  const compact = value.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${compact}${end < value.length ? '…' : ''}`
}

// --- Attribution --------------------------------------------------
// "The senator said we must secure the border" is a report, not a position.
// This is the half of the old `rejectedOrAttributed` that still means "drop
// this hit". The other half — the author disagreeing — is no longer a reason
// to discard, because polarity is now carried on the claim.

const REPORTING = /\b(?:said|says|reported|according to|argued|claims?|claimed|called for|wants? to|proposed|announced|per the reports?)\b/i
const AUTHORIAL = /\b(?:I|we|our|my|should|must|need to|support|oppose|reject|deserve)\b/i

export function isAttributed(clause: string, match: RegExpMatchArray): boolean {
  const prefix = beforeMatch(clause, match)
  const reported = prefix.match(REPORTING)
  if (!reported) return false
  // An authorial cue only rescues the hit if it precedes the reporting verb.
  // In "The senator said we must secure the border" the "we must" belongs to
  // the senator, not the author, so it must not count as the author speaking.
  const authorial = prefix.match(AUTHORIAL)
  return !authorial || (authorial.index ?? 0) > (reported.index ?? 0)
}

// --- Polarity -------------------------------------------------------
// Whether the author is for or against the thing they just named. This is a
// FIELD, not a reason to discard. The previous scorer deleted any match whose
// clause began with "oppose", so every rule in the file worked only when the
// author happened to agree with it — "I oppose cutting Medicaid" scored
// nothing at all.

export const AGAINST_CUE =
  /\b(?:oppose[sd]?|opposing|against|reject(?:s|ed|ing)?|should\s+not|shouldn't|must\s+not|mustn't|do\s+not\s+support|don't\s+support|cannot\s+support|can't\s+support|refuse\s+to|no\s+to)\b/i

export const FOR_CUE =
  /\b(?:I\s+support|we\s+support|support(?:s|ing)?|should|must|need(?:s)?\s+to|ought\s+to|deserve[sd]?|call(?:s|ing)?\s+for|demand(?:s|ing)?|it'?s\s+time\s+to|let'?s|endorse[sd]?|has\s+to|have\s+to)\b/i

/**
 * Opposition is often expressed by disparaging the thing rather than by any
 * oppose-cue: "student loan forgiveness IS A REGRESSIVE GIVEAWAY". Restricted
 * to the copular form so it cannot swallow ordinary criticism elsewhere in the
 * clause — "a minimum wage kills jobs" is already handled by a rule, and
 * flipping it here as well would invert it.
 */
const DISPARAGING =
  /\b(?:is|are|was|were|remains?)\s+(?:a|an|the)?\s*(?:[\w-]+\s+){0,2}?(?:giveaway|boondoggle|disaster|scam|sham|failure|mistake|handout|waste|fiasco|gimmick|overreach|non-starter)\b/i

export type Polarity = 'for' | 'against'

/** Text from the end of the match to the end of the clause. */
export function afterMatch(value: string, match: RegExpMatchArray): string {
  const end = (match.index ?? 0) + match[0].length
  return value.slice(end)
}

export function polarityOf(clause: string, match: RegExpMatchArray): Polarity {
  if (AGAINST_CUE.test(beforeMatch(clause, match))) return 'against'
  if (DISPARAGING.test(afterMatch(clause, match))) return 'against'
  return 'for'
}

/** The author explicitly declines to take a side. Beats every other signal. */
export const EXPLICIT_NO_POSITION =
  /\b(?:I|we)\s+(?:have not|haven't|do not|don't)\s+(?:taken|take|have)\s+(?:a |any )?position\b|\bI(?:'m| am) still undecided\b|\byou can be (?:for or against|against or for)\b|\bbefore choosing a side\b/i
