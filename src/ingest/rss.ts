// RSS 2.0 / Atom feed fetching and normalization.

import { XMLParser } from 'fast-xml-parser'

export type FeedItem = {
  title: string
  url: string
  summary: string        // description/summary, HTML stripped
  contentHtml: string    // content:encoded / atom content when present
  publishedAt: Date | null
  categories: string[]
  imageUrl: string | null
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Feeds wrap text in CDATA; keep everything as strings
  parseTagValue: false,
})

const asArray = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v]

const text = (v: unknown): string => {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object' && '#text' in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)['#text'] ?? '')
  }
  return String(v)
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

function parseDate(v: string): Date | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeRssItem(item: any): FeedItem | null {
  const url = text(item.link) || text(item.guid)
  if (!url.startsWith('http')) return null
  const media =
    item.enclosure?.['@_url'] ??
    item['media:content']?.['@_url'] ??
    asArray(item['media:content'])[0]?.['@_url'] ??
    item['media:thumbnail']?.['@_url'] ??
    null
  return {
    title: stripHtml(text(item.title)),
    url,
    summary: stripHtml(text(item.description)),
    contentHtml: text(item['content:encoded']),
    publishedAt: parseDate(text(item.pubDate) || text(item['dc:date'])),
    categories: asArray(item.category).map(text).filter(Boolean),
    imageUrl: media ? String(media) : null,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeAtomEntry(entry: any): FeedItem | null {
  const links = asArray(entry.link)
  const alt =
    links.find((l: any) => l['@_rel'] === 'alternate') ?? links[0]  // eslint-disable-line @typescript-eslint/no-explicit-any
  const url = alt?.['@_href'] ?? text(entry.link)
  if (!url || !String(url).startsWith('http')) return null
  return {
    title: stripHtml(text(entry.title)),
    url: String(url),
    summary: stripHtml(text(entry.summary)),
    contentHtml: text(entry.content),
    publishedAt: parseDate(text(entry.published) || text(entry.updated)),
    categories: asArray(entry.category)
      .map((c: any) => c['@_term'] ?? text(c))  // eslint-disable-line @typescript-eslint/no-explicit-any
      .filter(Boolean),
    imageUrl: null,
  }
}

export async function fetchFeed(feedUrl: string, timeoutMs = 15000): Promise<FeedItem[]> {
  const res = await fetch(feedUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': 'forum-ingest/1.0 (+https://github.com/mtan09/forum)',
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
    },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`${feedUrl} → HTTP ${res.status}`)
  const xml = await res.text()
  const doc = parser.parse(xml)

  if (doc.rss?.channel) {
    return asArray(doc.rss.channel.item)
      .map(normalizeRssItem)
      .filter((i): i is FeedItem => i !== null)
  }
  if (doc.feed) {
    return asArray(doc.feed.entry)
      .map(normalizeAtomEntry)
      .filter((i): i is FeedItem => i !== null)
  }
  throw new Error(`${feedUrl} → not a recognizable RSS/Atom document`)
}
