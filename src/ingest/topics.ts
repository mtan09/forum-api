// Deterministic general-topic assignment by keyword matching. Topics are
// background metadata now (profile spectrums, For You/Against You);
// subtopics are assigned separately by the clustering pass.

import { query } from '../db'

const TOPIC_KEYWORDS: Record<string, string[]> = {
  'elections': [
    'election', 'ballot', 'voter', 'voting', 'campaign', 'poll', 'primary',
    'midterm', 'congress', 'senate', 'house of representatives', 'redistricting',
    'filibuster', 'impeach', 'inauguration', 'candidate', 'incumbent',
    'electoral', 'governor race', 'swing state',
  ],
  'foreign-policy': [
    'ukraine', 'russia', 'china', 'israel', 'gaza', 'iran', 'nato', 'war',
    'military', 'defense', 'pentagon', 'sanctions', 'diplomacy', 'treaty',
    'north korea', 'taiwan', 'foreign policy', 'ambassador', 'state department',
    'troops', 'missile', 'ceasefire',
  ],
  'economy': [
    'economy', 'inflation', 'jobs report', 'unemployment', 'wages', 'tariff',
    'trade', 'tax', 'budget', 'deficit', 'federal reserve', 'interest rate',
    'recession', 'gdp', 'labor', 'union', 'minimum wage', 'housing', 'stocks',
    'debt ceiling', 'spending bill',
  ],
  'tech': [
    'artificial intelligence', ' ai ', 'silicon valley', 'social media',
    'privacy', 'data', 'antitrust', 'crypto', 'broadband', 'cybersecurity',
    'chip', 'semiconductor', 'big tech', 'algorithm', 'surveillance',
    'tiktok', 'meta', 'google', 'apple', 'openai', 'anthropic',
  ],
  'immigration': [
    'immigration', 'immigrant', 'border', 'asylum', 'migrant', 'deportation',
    'visa', 'refugee', 'ice raids', 'customs', 'daca', 'green card',
    'border patrol', 'sanctuary city',
  ],
  'health': [
    'health', 'healthcare', 'medicare', 'medicaid', 'vaccine', 'pandemic',
    'climate', 'environment', 'epa', 'pollution', 'emissions', 'energy',
    'drug price', 'opioid', 'mental health', 'hospital', 'insurance',
    'wildfire', 'hurricane', 'drought', 'renewable',
  ],
  'rights': [
    'abortion', 'gun', 'second amendment', 'free speech', 'first amendment',
    'lgbtq', 'transgender', 'civil rights', 'voting rights', 'religious',
    'censorship', 'police', 'criminal justice', 'supreme court', 'roe',
    'discrimination', 'affirmative action', 'death penalty',
  ],
}

type TopicRow = { id: string; slug: string }

let cache: { topics: TopicRow[]; loadedAt: number } | null = null

async function loadTaxonomy() {
  if (cache && Date.now() - cache.loadedAt < 10 * 60_000) return cache
  const topics = await query('SELECT id, slug FROM general_topics')
  cache = { topics: topics.rows, loadedAt: Date.now() }
  return cache
}

function countMatches(haystack: string, keywords: string[]): number {
  let n = 0
  for (const kw of keywords) {
    let idx = -1
    while ((idx = haystack.indexOf(kw.toLowerCase(), idx + 1)) !== -1) n++
  }
  return n
}

export async function matchTopic(text: string): Promise<{
  generalTopicId: string | null
  matchStrength: number
}> {
  const { topics } = await loadTaxonomy()
  const haystack = ` ${text.toLowerCase()} `

  let bestSlug: string | null = null
  let bestCount = 0
  for (const [slug, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    const count = countMatches(haystack, keywords)
    if (count > bestCount) {
      bestCount = count
      bestSlug = slug
    }
  }
  // Fewer than 2 keyword hits = not confidently on-topic
  if (!bestSlug || bestCount < 2) {
    return { generalTopicId: null, matchStrength: 0 }
  }

  const topic = topics.find((t) => t.slug === bestSlug)
  if (!topic) return { generalTopicId: null, matchStrength: 0 }

  return { generalTopicId: topic.id, matchStrength: Math.min(bestCount / 6, 1) }
}
