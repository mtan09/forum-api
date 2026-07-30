const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has',
  'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was',
  'were', 'will', 'with',
])

export function searchTerms(value: string): string[] {
  return Array.from(new Set(
    (value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .filter((term) => term.length >= 2 && !STOP_WORDS.has(term))
  )).slice(0, 8)
}

// Adjacent meaningful terms preserve event phrases such as "war powers" and
// "nuclear deal". Phrase fallback adds recall without turning every query
// into a loose OR search across unrelated headlines.
export function searchPhrases(terms: string[]): string[] {
  if (terms.length < 2) return []
  return Array.from(new Set(
    terms.slice(0, -1).map((term, index) => `${term} ${terms[index + 1]}`)
  )).slice(0, 7)
}
