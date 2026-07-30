// Transient article extraction for scoring and structured-evidence creation.
//
// This restores the pre-rights-regression extractor from commit 29b905f: use
// a substantial feed body when available, otherwise run the publisher page
// through the readability extractor. The crucial boundary is downstream:
// analysisText is an in-memory value and must never be stored as article
// content, logged, or returned by an API.

import { extract } from '@extractus/article-extractor'
import { looksLikeVideoPlaylistChrome } from './content-quality'
import { stripHtml, type FeedItem } from './rss'
import type { SourceRights } from './source-rights'

const MIN_USABLE_CHARS = 600
const IMAGE_EXTENSION = /\.(?:avif|gif|jpe?g|png|webp)$/i

export type ExtractedArticle = {
  analysisText: string
  analysisMethod: 'metadata' | 'feed' | 'full_page'
  publicDescription: string | null
  imageUrl: string | null
  publishedAt: Date | null
  usedFullPage: boolean
}

function enabled(name: string, fallback = true): boolean {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  return !['0', 'false', 'off', 'no'].includes(raw.toLowerCase())
}

// Page meta dates come in whatever format the site chose. An invalid date
// must fall back to the feed date instead of aborting an entire ingest batch.
function parsePageDate(value: string | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

// Some page metadata is malformed. The Hill, for example, occasionally
// exposes an article URL followed by an encoded caption as its image value.
export function normalizeArticleImageUrl(
  candidate: string | null | undefined,
  articleUrl: string
): string | null {
  const value = candidate?.trim()
  if (!value) return null

  try {
    const image = new URL(value, articleUrl)
    if (image.protocol !== 'http:' && image.protocol !== 'https:') return null

    const article = new URL(articleUrl)
    const articlePath = article.pathname.replace(/\/+$/, '')
    const imagePath = image.pathname.replace(/\/+$/, '')
    const looksLikeImage = IMAGE_EXTENSION.test(imagePath)

    if (
      image.origin === article.origin &&
      articlePath &&
      (imagePath === articlePath || imagePath.startsWith(`${articlePath}/`)) &&
      !looksLikeImage
    ) {
      return null
    }

    return image.href
  } catch {
    return null
  }
}

export function selectArticleImageUrl(
  articleUrl: string,
  feedImage: string | null | undefined,
  pageImage?: string | null
): string | null {
  return (
    normalizeArticleImageUrl(feedImage, articleUrl) ??
    normalizeArticleImageUrl(pageImage, articleUrl)
  )
}

export async function extractArticleText(
  item: FeedItem,
  rights: SourceRights
): Promise<ExtractedArticle> {
  const feedText = stripHtml(item.contentHtml || '') || item.summary
  const transientEnabled = enabled('ARTICLE_TRANSIENT_ANALYSIS_ENABLED')
  const mayAnalyzeFeedText = transientEnabled && (
    rights.analysis === 'feed_text_transient' ||
    rights.analysis === 'full_page_transient'
  )
  const mayFetchPage = transientEnabled &&
    rights.acquisition === 'full_page' &&
    rights.analysis === 'full_page_transient'
  const mayDisplayFeedText =
    rights.publicText === 'feed_description'
  const mayUseFeedImage = rights.image !== 'none'

  if (mayAnalyzeFeedText && feedText.length >= MIN_USABLE_CHARS) {
    return {
      analysisText: feedText,
      analysisMethod: 'feed',
      publicDescription: mayDisplayFeedText ? item.summary || null : null,
      imageUrl: mayUseFeedImage
        ? selectArticleImageUrl(item.url, item.imageUrl)
        : null,
      publishedAt: item.publishedAt,
      usedFullPage: false,
    }
  }

  if (mayFetchPage) {
    try {
      const page = await extract(item.url, {}, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; forum-ingest/1.0)' },
      })
      const pageText = stripHtml(page?.content ?? '')
      if (
        pageText.length >= MIN_USABLE_CHARS &&
        !looksLikeVideoPlaylistChrome(pageText)
      ) {
        return {
          analysisText: pageText,
          analysisMethod: 'full_page',
          publicDescription: mayDisplayFeedText ? item.summary || null : null,
          imageUrl: mayUseFeedImage
            ? selectArticleImageUrl(item.url, item.imageUrl, page?.image)
            : null,
          publishedAt: parsePageDate(page?.published) ?? item.publishedAt,
          usedFullPage: true,
        }
      }
    } catch {
      // Publisher bot walls and paywalls are expected. Fall back to the feed
      // without logging the URL or extracted text.
    }
  }

  return {
    analysisText: mayAnalyzeFeedText ? feedText : '',
    analysisMethod: mayAnalyzeFeedText && feedText ? 'feed' : 'metadata',
    publicDescription: mayDisplayFeedText ? item.summary || null : null,
    imageUrl: mayUseFeedImage ? selectArticleImageUrl(item.url, item.imageUrl) : null,
    publishedAt: item.publishedAt,
    usedFullPage: false,
  }
}
