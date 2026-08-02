import { createHash } from 'node:crypto'

export type InterestDefinition = {
  key: string
  label: string
  description: string
  topicSlugs: string[]
  terms: string[]
}

// Durable interests intentionally stay broader than the live story clusters.
// Onboarding should teach the recommender what a person cares about, not ask
// them to choose between several names dominating one news cycle.
export const INTEREST_CATALOG: InterestDefinition[] = [
  { key: 'economy', label: 'Economy & jobs', description: 'Inflation, taxes, trade, jobs, and growth', topicSlugs: ['economy'], terms: ['economy', 'inflation', 'taxes', 'trade', 'jobs', 'unemployment', 'recession', 'federal reserve', 'budget', 'deficit'] },
  { key: 'immigration', label: 'Immigration', description: 'Borders, asylum, visas, and migration policy', topicSlugs: ['immigration'], terms: ['immigration', 'border', 'asylum', 'visa', 'refugee', 'migration', 'deportation', 'daca'] },
  { key: 'healthcare', label: 'Health care', description: 'Coverage, public health, medicine, and costs', topicSlugs: ['health'], terms: ['healthcare', 'health care', 'medicare', 'medicaid', 'insurance', 'hospital', 'drug prices', 'public health'] },
  { key: 'climate', label: 'Climate & energy', description: 'Climate, conservation, energy, and the environment', topicSlugs: ['health'], terms: ['climate', 'environment', 'energy', 'emissions', 'pollution', 'renewable', 'oil', 'gas', 'epa'] },
  { key: 'foreign_policy', label: 'Foreign policy', description: 'Diplomacy, security, conflict, and world affairs', topicSlugs: ['foreign-policy'], terms: ['foreign policy', 'diplomacy', 'war', 'military', 'national security', 'sanctions', 'nato', 'china', 'russia', 'middle east'] },
  { key: 'elections', label: 'Elections & democracy', description: 'Campaigns, voting, Congress, and government', topicSlugs: ['elections'], terms: ['elections', 'campaign', 'voting', 'ballot', 'congress', 'senate', 'house', 'democracy', 'redistricting'] },
  { key: 'courts_rights', label: 'Courts & civil rights', description: 'Courts, policing, speech, equality, and liberty', topicSlugs: ['rights'], terms: ['supreme court', 'courts', 'civil rights', 'free speech', 'police', 'criminal justice', 'discrimination', 'religious liberty'] },
  { key: 'tech_policy', label: 'Technology', description: 'AI, privacy, platforms, cybersecurity, and innovation', topicSlugs: ['tech'], terms: ['technology', 'artificial intelligence', 'ai', 'privacy', 'social media', 'cybersecurity', 'big tech', 'antitrust', 'crypto'] },
  { key: 'education', label: 'Education', description: 'Schools, universities, curriculum, and student policy', topicSlugs: ['rights'], terms: ['education', 'schools', 'college', 'university', 'students', 'teachers', 'curriculum', 'student loans'] },
  { key: 'guns', label: 'Gun policy', description: 'Gun rights, regulation, and public safety', topicSlugs: ['rights'], terms: ['guns', 'firearms', 'second amendment', 'gun control', 'background checks', 'mass shooting'] },
  { key: 'abortion', label: 'Abortion policy', description: 'Reproductive rights, restrictions, and access', topicSlugs: ['rights'], terms: ['abortion', 'reproductive rights', 'reproductive health', 'roe', 'planned parenthood'] },
  { key: 'labor', label: 'Labor & unions', description: 'Workers, wages, unions, and workplace policy', topicSlugs: ['economy'], terms: ['labor', 'unions', 'workers', 'wages', 'minimum wage', 'strike', 'collective bargaining'] },
  { key: 'housing', label: 'Housing', description: 'Rent, mortgages, affordability, and development', topicSlugs: ['economy'], terms: ['housing', 'rent', 'mortgage', 'home prices', 'affordable housing', 'zoning', 'homelessness'] },
]

const HASH_DIMENSIONS = 64
export const SEMANTIC_DIMENSIONS = INTEREST_CATALOG.length + HASH_DIMENSIONS

const clean = (value: string) => value
  .toLowerCase()
  .replace(/[^a-z0-9\s-]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

function stem(token: string): string {
  if (token.length <= 4) return token
  return token
    .replace(/(ization|ational|fulness|ousness|iveness)$/i, '')
    .replace(/(ments|ment|ings|ing|ers|ies|ed|es|s)$/i, '')
}

function hashIndex(value: string): number {
  const digest = createHash('sha256').update(value).digest()
  return digest.readUInt32BE(0) % HASH_DIMENSIONS
}

export function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return magnitude > 0 ? vector.map((value) => value / magnitude) : vector
}

export function semanticEmbedding(value: string): number[] {
  const text = ` ${clean(value)} `
  const vector = Array.from({ length: SEMANTIC_DIMENSIONS }, () => 0)

  INTEREST_CATALOG.forEach((interest, index) => {
    let hits = 0
    for (const term of interest.terms) {
      const needle = ` ${clean(term)} `
      let offset = 0
      while ((offset = text.indexOf(needle, offset)) >= 0) {
        hits++
        offset += needle.length
      }
    }
    vector[index] = Math.log1p(hits) * 1.8
  })

  const tokens = text.trim().split(' ').map(stem).filter((token) => token.length >= 3)
  const features = [...tokens]
  for (let i = 0; i < tokens.length - 1; i++) features.push(`${tokens[i]}_${tokens[i + 1]}`)
  for (const feature of features) {
    vector[INTEREST_CATALOG.length + hashIndex(feature)] += feature.includes('_') ? 0.55 : 0.35
  }
  return normalizeVector(vector)
}

export function interestEmbedding(key: string): number[] {
  const index = INTEREST_CATALOG.findIndex((interest) => interest.key === key)
  if (index < 0) return Array.from({ length: SEMANTIC_DIMENSIONS }, () => 0)
  const interest = INTEREST_CATALOG[index]
  const vector = semanticEmbedding(`${interest.label} ${interest.description} ${interest.terms.join(' ')}`)
  // Preserve a strong, unambiguous concept coordinate even when the hashed
  // lexical part overlaps with neighboring policy areas.
  vector[index] += 1.5
  return normalizeVector(vector)
}

export function combineVectors(
  values: { vector: number[] | null | undefined; weight: number }[]
): number[] {
  const combined = Array.from({ length: SEMANTIC_DIMENSIONS }, () => 0)
  for (const { vector, weight } of values) {
    if (!vector || !Number.isFinite(weight) || weight === 0) continue
    for (let i = 0; i < Math.min(vector.length, combined.length); i++) {
      combined[i] += Number(vector[i] ?? 0) * weight
    }
  }
  return normalizeVector(combined)
}

export function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  const length = Math.min(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const l = Number(left[i] ?? 0)
    const r = Number(right[i] ?? 0)
    dot += l * r
    leftMagnitude += l * l
    rightMagnitude += r * r
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0
  return Math.max(0, Math.min(1, dot / Math.sqrt(leftMagnitude * rightMagnitude)))
}

export function validInterestKeys(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const allowed = new Set(INTEREST_CATALOG.map((interest) => interest.key))
  return [...new Set(values.map(String).filter((value) => allowed.has(value)))].slice(
    0,
    INTEREST_CATALOG.length
  )
}
