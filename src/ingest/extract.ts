// Policy-aware feed field selection.
//
// This module intentionally does not fetch publisher article pages. A public
// RSS feed is useful for discovering a URL, but is not treated as permission
// to copy the page body, feed description, or photograph. Broader uses are
// enabled only by the reviewed source-rights registry.

import { stripHtml, type FeedItem } from './rss'
import type { SourceRights } from './source-rights'

const IMAGE_EXTENSION = /\.(?:avif|gif|jpe?g|png|webp)$/i

export type ExtractedArticle = {
  analysisText: string
  publicDescription: string | null
  imageUrl: string | null
  publishedAt: Date | null
  usedFullPage: boolean
}

// Validate an image only after the source policy has permitted that feed
// field. This protects clients from malformed values; it does not grant
// rights by itself.
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
  feedImage: string | null | undefined
): string | null {
  return normalizeArticleImageUrl(feedImage, articleUrl)
}

export async function extractArticleText(
  item: FeedItem,
  rights: SourceRights
): Promise<ExtractedArticle> {
  const feedText = stripHtml(item.contentHtml || '') || item.summary
  const mayAnalyzeFeedText =
    rights.acquisition === 'feed_text' &&
    rights.analysis === 'permitted_text'
  const mayDisplayFeedText =
    rights.acquisition === 'feed_text' &&
    rights.publicText === 'feed_description'
  const mayUseFeedImage = rights.image !== 'none'

  return {
    analysisText: mayAnalyzeFeedText ? feedText : '',
    publicDescription: mayDisplayFeedText ? item.summary || null : null,
    imageUrl: mayUseFeedImage ? selectArticleImageUrl(item.url, item.imageUrl) : null,
    publishedAt: item.publishedAt,
    usedFullPage: false,
  }
}
