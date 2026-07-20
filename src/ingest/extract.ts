// Full-text extraction for scoring. The scorer needs body text, not
// just the RSS blurb — feed content is used when substantial, otherwise
// the article page is fetched and run through a readability extractor.
// Paywalls and bot-walls are expected: extraction failure falls back to
// title + summary (the scorer then reports lower confidence naturally
// via its word-count term).

import { extract } from '@extractus/article-extractor'
import { stripHtml, type FeedItem } from './rss'

const MIN_USABLE_CHARS = 600

export type ExtractedArticle = {
  text: string
  imageUrl: string | null
  publishedAt: Date | null
  usedFullPage: boolean
}

// Page meta dates come in whatever format the site chose; an unparseable
// one must fall back to the feed date, never become an Invalid Date
// (Postgres rejects the NaN timestamp and the whole source batch fails).
function parsePageDate(v: string | undefined): Date | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function extractArticleText(item: FeedItem): Promise<ExtractedArticle> {
  const feedText = stripHtml(item.contentHtml || '') || item.summary

  if (feedText.length >= MIN_USABLE_CHARS) {
    return { text: feedText, imageUrl: item.imageUrl, publishedAt: item.publishedAt, usedFullPage: false }
  }

  try {
    const page = await extract(item.url, {}, {
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; forum-ingest/1.0)' },
    })
    const pageText = stripHtml(page?.content ?? '')
    if (pageText.length >= MIN_USABLE_CHARS) {
      return {
        text: pageText,
        imageUrl: page?.image || item.imageUrl,
        publishedAt: parsePageDate(page?.published) ?? item.publishedAt,
        usedFullPage: true,
      }
    }
  } catch {
    // fall through to feed text
  }

  return { text: feedText, imageUrl: item.imageUrl, publishedAt: item.publishedAt, usedFullPage: false }
}
