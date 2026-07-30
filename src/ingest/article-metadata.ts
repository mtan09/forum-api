import { extractKeywords, toHashtags, type Keywords } from './keywords'

const ENTITY_STOP = new Set([
  'A', 'An', 'And', 'As', 'At', 'Breaking', 'Exclusive', 'For', 'From', 'How',
  'In', 'Live', 'New', 'On', 'The', 'To', 'US', 'U.S', 'Watch', 'What', 'When',
  'Where', 'Who', 'Why', 'With',
])

// Headline-only entity extraction is intentionally conservative. It produces
// a non-reconstructive search/cluster feature, not a quotation or replacement
// for the underlying reporting.
export function extractHeadlineEntities(title: string): string[] {
  const candidates = title.match(
    /\b(?:[A-Z][A-Za-z'’-]+|[A-Z]{2,})(?:\s+(?:[A-Z][A-Za-z'’-]+|[A-Z]{2,})){0,3}\b/g
  ) ?? []
  const entities: string[] = []
  for (const value of candidates) {
    const clean = value.replace(/[’]/g, "'").trim()
    if (clean.length < 3 || ENTITY_STOP.has(clean)) continue
    if (!entities.some((entity) => entity.toLowerCase() === clean.toLowerCase())) {
      entities.push(clean)
    }
    if (entities.length >= 12) break
  }
  return entities
}

export type ArticleMetadata = {
  entities: string[]
  eventTerms: string[]
  hashtags: string[]
  searchText: string
}

export function buildArticleMetadata(
  title: string,
  source: string,
  categories: string[] = []
): ArticleMetadata {
  const categoryText = categories.slice(0, 8).join(' ')
  const entities = extractHeadlineEntities(title)
  const keywords = extractKeywords(title, categoryText, 500)
  const eventTerms = keywords.top.slice(0, 16)
  const hashtags = toHashtags(eventTerms)
  const searchText = [
    title,
    source,
    categoryText,
    entities.join(' '),
    eventTerms.join(' '),
  ].filter(Boolean).join(' ')

  return { entities, eventTerms, hashtags, searchText }
}

// Entity phrases are added directly because the general news-keyword
// extractor intentionally suppresses ubiquitous political names to prevent
// body-text clusters from snowballing. Metadata clustering has much less text,
// so named-entity overlap is useful when combined with event terms.
export function metadataKeywordProfile(
  title: string,
  entities: string[] = [],
  eventTerms: string[] = [],
  description = ''
): Keywords {
  const profile = extractKeywords(
    title,
    `${eventTerms.join(' ')} ${description}`,
    800
  )
  for (const entity of entities) {
    const normalized = entity.toLowerCase().replace(/[’]/g, "'").trim()
    if (normalized.length < 3) continue
    profile.terms.set(`entity:${normalized}`, (profile.terms.get(`entity:${normalized}`) ?? 0) + 8)
  }
  profile.top = [...profile.terms.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 16)
    .map(([term]) => term)
  return profile
}
