// Deterministic keyword extraction — the shared vocabulary for article
// hashtags and story clustering. No models: term frequency over the
// title (weighted 3×) and lead text, minus stopwords. Same input, same
// keywords, always.

const STOPWORDS = new Set([
  // core english
  'the','a','an','and','or','but','if','then','than','that','this','these','those',
  'is','are','was','were','be','been','being','am','it','its','as','at','by','for',
  'from','in','into','of','on','onto','to','with','without','over','under','about',
  'after','before','between','during','through','up','down','out','off','again',
  'he','she','they','them','his','her','their','theirs','we','our','ours','you',
  'your','yours','i','me','my','mine','who','whom','whose','which','what','when',
  'where','why','how','all','any','both','each','few','more','most','other','some',
  'such','no','nor','not','only','own','same','so','too','very','can','will','just',
  'should','could','would','may','might','must','shall','do','does','did','doing',
  'have','has','had','having','there','here','also','because','while','until',
  // news boilerplate — appears everywhere, distinguishes nothing
  'said','says','say','told','according','report','reports','reported','news',
  'week','month','year','years','day','days','today','yesterday','tomorrow',
  'monday','tuesday','wednesday','thursday','friday','saturday','sunday',
  'new','first','last','latest','breaking','exclusive','update','updated','live',
  'people','one','two','three','many','much','get','gets','got','make','makes',
  'made','take','takes','took','like','back','still','even','way','time','times',
  'amid','among','despite','since','around','across','via','per','including',
  'read','watch','video','photo','story','article','post','comment','share',
  // too-generic politics words — every political story has them, so they
  // glue unrelated stories together if kept
  'president','presidents','government','state','states','federal','washington',
  'american','americans','america','political','politics','country','nation',
  'national','house','senate','congress','administration','official','officials',
  'party','bill','law','plan','policy','vote','election','campaign',
  'republican','republicans','democrat','democrats','democratic','gop',
  'us','u.s','usa','trump','biden','white',
])

// Words are kept lowercase; hyphens/apostrophes allowed inside a word.
const WORD_RE = /[a-z][a-z'’-]{2,}/g

export type Keywords = {
  terms: Map<string, number>   // term -> weight (unigrams + bigrams)
  top: string[]                // highest-weight terms, unigrams first
}

function normalize(word: string): string {
  return word.replace(/[’']/g, "'").replace(/^-+|-+$/g, '')
}

export function extractKeywords(title: string, content: string, maxLead = 1500): Keywords {
  const terms = new Map<string, number>()

  const addTokens = (text: string, weight: number) => {
    const words = (text.toLowerCase().match(WORD_RE) ?? [])
      .map(normalize)
      .filter((w) => w.length >= 3)
    // unigrams
    for (const w of words) {
      if (STOPWORDS.has(w)) continue
      terms.set(w, (terms.get(w) ?? 0) + weight)
    }
    // bigrams of consecutive non-stopwords carry more meaning; weight double
    for (let i = 0; i < words.length - 1; i++) {
      if (STOPWORDS.has(words[i]) || STOPWORDS.has(words[i + 1])) continue
      const bg = `${words[i]} ${words[i + 1]}`
      terms.set(bg, (terms.get(bg) ?? 0) + weight * 2)
    }
  }

  addTokens(title, 3)
  addTokens(content.slice(0, maxLead), 1)

  const top = [...terms.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))  // weight, then alpha for determinism
    .slice(0, 16)
    .map(([term]) => term)

  return { terms, top }
}

// Similarity between two keyword profiles: weighted overlap normalized by
// the smaller profile, so a short item can still fully match a long one.
export function keywordSimilarity(a: Keywords, b: Keywords): number {
  let shared = 0
  let sumA = 0
  let sumB = 0
  for (const [term, w] of a.terms) {
    sumA += w
    const wb = b.terms.get(term)
    if (wb !== undefined) shared += Math.min(w, wb)
  }
  for (const [, w] of b.terms) sumB += w
  const denom = Math.min(sumA, sumB)
  return denom > 0 ? shared / denom : 0
}

// Hashtag form of the top keywords: lowercase, hyphenless slugs.
export function toHashtags(top: string[], max = 5): string[] {
  const tags: string[] = []
  for (const term of top) {
    const slug = term.replace(/[^a-z0-9 ]/g, '').trim().replace(/ +/g, '')
    if (slug.length < 3 || slug.length > 30) continue
    if (!tags.includes(slug)) tags.push(slug)
    if (tags.length >= max) break
  }
  return tags
}
