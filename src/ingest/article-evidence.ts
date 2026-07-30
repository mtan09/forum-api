import { createHash } from 'node:crypto'
import OpenAI from 'openai'
import { query } from '../db'
import { captureException, captureMessage } from '../lib/sentry'
import { buildArticleMetadata, extractHeadlineEntities } from './article-metadata'
import { extractKeywords } from './keywords'

export const ARTICLE_EVIDENCE_VERSION = '2026-07-29.1'

export type EvidenceClaim = {
  subject: string
  claim: string
  attribution: string
  confidence: number
}

export type TimelineFact = {
  date: string | null
  event: string
  confidence: number
}

export type EvidenceRelationship = {
  from: string
  relationship: string
  to: string
}

export type StructuredArticleEvidence = {
  extractionVersion: string
  sourceTextHash: string | null
  wordCount: number
  summary: string
  claims: EvidenceClaim[]
  timeline: TimelineFact[]
  relationships: EvidenceRelationship[]
  disputedPoints: string[]
  entities: string[]
  eventTerms: string[]
  searchText: string
  extractionMethod: 'metadata' | 'feed' | 'full_page'
  confidence: number
  generatedBy: 'deterministic' | 'openai'
}

type EvidenceInput = {
  title: string
  source: string
  categories: string[]
  analysisText: string
  extractionMethod: StructuredArticleEvidence['extractionMethod']
}

const MAX_ANALYSIS_CHARS = 18_000
const MAX_ARRAY_ITEMS = 10

function flag(name: string, fallback = true): boolean {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  return !['0', 'false', 'off', 'no'].includes(raw.toLowerCase())
}

function compact(value: unknown, max = 280): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function unique(values: string[], max = MAX_ARRAY_ITEMS): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    const clean = compact(value, 140)
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) continue
    seen.add(key)
    output.push(clean)
    if (output.length >= max) break
  }
  return output
}

function safeConfidence(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.min(1, parsed))
}

function deterministicEvidence(input: EvidenceInput): StructuredArticleEvidence {
  const metadata = buildArticleMetadata(input.title, input.source, input.categories)
  const bodyKeywords = input.analysisText
    ? extractKeywords(input.title, input.analysisText, 10_000).top
    : []
  const bodyEntities = input.analysisText
    ? extractHeadlineEntities(input.analysisText.slice(0, 12_000))
    : []
  const entities = unique([...metadata.entities, ...bodyEntities], 16)
  const eventTerms = unique([...metadata.eventTerms, ...bodyKeywords], 24)
  const wordCount = input.analysisText.trim()
    ? input.analysisText.trim().split(/\s+/).length
    : 0
  const searchText = unique([
    input.title,
    input.source,
    ...input.categories,
    ...entities,
    ...eventTerms,
  ], 80).join(' ')

  return {
    extractionVersion: ARTICLE_EVIDENCE_VERSION,
    sourceTextHash: input.analysisText
      ? createHash('sha256').update(input.analysisText).digest('hex')
      : null,
    wordCount,
    summary: `${input.source} reports on ${compact(input.title, 180)}.`,
    claims: [],
    timeline: [],
    relationships: [],
    disputedPoints: [],
    entities,
    eventTerms,
    searchText,
    extractionMethod: input.extractionMethod,
    confidence: wordCount >= 300 ? 0.55 : 0.3,
    generatedBy: 'deterministic',
  }
}

async function reserveAnalysisRequest(): Promise<boolean> {
  const dailyLimit = Math.max(0, Number(process.env.ARTICLE_ANALYSIS_DAILY_LIMIT ?? 500))
  if (dailyLimit === 0) return false
  const result = await query(
    `INSERT INTO article_analysis_usage (day, requests)
     VALUES (CURRENT_DATE, 1)
     ON CONFLICT (day) DO UPDATE
       SET requests = article_analysis_usage.requests + 1,
           updated_at = NOW()
       WHERE article_analysis_usage.requests < $1
     RETURNING requests`,
    [dailyLimit]
  )
  if (result.rowCount === 0) {
    captureMessage('Article structured-evidence daily limit reached', 'warning', {
      dailyLimit,
    })
    return false
  }
  return true
}

function parseModelEvidence(
  raw: string,
  input: EvidenceInput,
  fallback: StructuredArticleEvidence
): StructuredArticleEvidence {
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const claims = Array.isArray(parsed.claims) ? parsed.claims : []
  const timeline = Array.isArray(parsed.timeline) ? parsed.timeline : []
  const relationships = Array.isArray(parsed.relationships) ? parsed.relationships : []
  const entities = unique([
    ...fallback.entities,
    ...(Array.isArray(parsed.entities) ? parsed.entities.map(String) : []),
  ], 18)
  const eventTerms = unique([
    ...fallback.eventTerms,
    ...(Array.isArray(parsed.event_terms) ? parsed.event_terms.map(String) : []),
  ], 26)

  return {
    ...fallback,
    summary: compact(parsed.summary, 500) || fallback.summary,
    claims: claims.slice(0, MAX_ARRAY_ITEMS).flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const item = value as Record<string, unknown>
      const subject = compact(item.subject, 100)
      const claim = compact(item.claim, 280)
      if (!subject || !claim) return []
      return [{
        subject,
        claim,
        attribution: compact(item.attribution, 100) || input.source,
        confidence: safeConfidence(item.confidence, 0.65),
      }]
    }),
    timeline: timeline.slice(0, MAX_ARRAY_ITEMS).flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const item = value as Record<string, unknown>
      const event = compact(item.event, 240)
      if (!event) return []
      return [{
        date: compact(item.date, 30) || null,
        event,
        confidence: safeConfidence(item.confidence, 0.65),
      }]
    }),
    relationships: relationships.slice(0, MAX_ARRAY_ITEMS).flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const item = value as Record<string, unknown>
      const from = compact(item.from, 100)
      const relationship = compact(item.relationship, 120)
      const to = compact(item.to, 100)
      return from && relationship && to ? [{ from, relationship, to }] : []
    }),
    disputedPoints: unique(
      Array.isArray(parsed.disputed_points) ? parsed.disputed_points.map(String) : [],
      8
    ),
    entities,
    eventTerms,
    searchText: unique([
      fallback.searchText,
      compact(parsed.summary, 500),
      ...entities,
      ...eventTerms,
      ...claims.map((value) => {
        if (!value || typeof value !== 'object') return ''
        return compact((value as Record<string, unknown>).claim, 280)
      }),
    ], 100).join(' '),
    confidence: safeConfidence(parsed.confidence, 0.72),
    generatedBy: 'openai',
  }
}

export async function buildStructuredEvidence(
  input: EvidenceInput
): Promise<StructuredArticleEvidence> {
  const fallback = deterministicEvidence(input)
  if (
    !input.analysisText ||
    !process.env.OPENAI_API_KEY ||
    !flag('ARTICLE_STRUCTURED_EVIDENCE_ENABLED')
  ) {
    return fallback
  }

  if (!(await reserveAnalysisRequest())) return fallback

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const response = await client.chat.completions.create({
      model: process.env.ARTICLE_ANALYSIS_MODEL || 'gpt-5.4-nano',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Convert one publisher article into compact structured evidence for a multi-source news index.

Return JSON only with: summary, claims, timeline, relationships, disputed_points, entities, event_terms, confidence.
- Paraphrase in fresh, neutral language. Do not quote or closely imitate sentences.
- summary: at most 70 words.
- claims: up to 8 objects with subject, claim, attribution, confidence.
- timeline: up to 6 objects with ISO date when known, event, confidence.
- relationships: up to 6 objects with from, relationship, to.
- disputed_points: only uncertainty or contestation explicitly present in the text.
- Do not infer missing facts. Attribute outlet-specific assertions to the publisher.
- Ignore subscription prompts, navigation, timestamps, related-story rails, and video-playlist chrome.`,
        },
        {
          role: 'user',
          content: `Publisher: ${input.source}\nHeadline: ${input.title}\nArticle text:\n${input.analysisText.slice(0, MAX_ANALYSIS_CHARS)}`,
        },
      ],
    })
    const content = response.choices[0]?.message?.content
    if (!content) return fallback
    return parseModelEvidence(content, input, fallback)
  } catch (error) {
    captureException(error, {
      component: 'article-evidence',
      source: input.source,
      extractionMethod: input.extractionMethod,
    })
    return fallback
  }
}
