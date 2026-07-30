import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { captureException } from '../lib/sentry'
import { publicStorageConfigured, putPublicObject } from '../lib/r2'

const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024
const THUMB_WIDTH = 640
const LARGE_WIDTH = 1280

export type ManagedArticleImage = {
  sourceUrl: string
  sourceHash: string
  thumbnailUrl: string
  largeUrl: string
  width: number
  height: number
  expiresAt: Date
}

function flag(name: string, fallback = true): boolean {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  return !['0', 'false', 'off', 'no'].includes(raw.toLowerCase())
}

export function managedArticleImagesConfigured(): boolean {
  return (
    flag('ARTICLE_MANAGED_IMAGES_ENABLED') &&
    publicStorageConfigured() &&
    Boolean(process.env.R2_PUBLIC_URL)
  )
}

async function downloadImage(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(12_000),
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 (compatible; forum-ingest/1.0)',
    },
  })
  if (!response.ok) throw new Error(`image HTTP ${response.status}`)
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`unexpected image content type ${contentType || 'missing'}`)
  }
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error('image exceeds download limit')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_DOWNLOAD_BYTES) {
    throw new Error('image is empty or exceeds download limit')
  }
  return bytes
}

export async function cacheManagedArticleImage(
  articleId: string,
  sourceUrl: string
): Promise<ManagedArticleImage | null> {
  if (!managedArticleImagesConfigured()) return null
  try {
    const input = await downloadImage(sourceUrl)
    const sourceHash = createHash('sha256').update(input).digest('hex')
    const normalized = sharp(input, { failOn: 'error' }).rotate()
    const metadata = await normalized.metadata()
    if (!metadata.width || !metadata.height) throw new Error('image dimensions unavailable')

    const [thumbnail, large] = await Promise.all([
      normalized
        .clone()
        .resize({ width: THUMB_WIDTH, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78, effort: 4 })
        .toBuffer(),
      normalized
        .clone()
        .resize({ width: LARGE_WIDTH, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, effort: 4 })
        .toBuffer(),
    ])
    const prefix = `articles/${articleId}/${sourceHash.slice(0, 16)}`
    const [thumbnailUrl, largeUrl] = await Promise.all([
      putPublicObject(`${prefix}-${THUMB_WIDTH}.webp`, thumbnail, 'image/webp'),
      putPublicObject(`${prefix}-${LARGE_WIDTH}.webp`, large, 'image/webp'),
    ])
    const cacheDays = Math.max(1, Number(process.env.ARTICLE_IMAGE_CACHE_DAYS ?? 30))
    return {
      sourceUrl,
      sourceHash,
      thumbnailUrl,
      largeUrl,
      width: metadata.width,
      height: metadata.height,
      expiresAt: new Date(Date.now() + cacheDays * 24 * 60 * 60_000),
    }
  } catch (error) {
    captureException(error, {
      component: 'article-image',
      articleId,
      sourceHost: (() => {
        try { return new URL(sourceUrl).host } catch { return 'invalid' }
      })(),
    })
    return null
  }
}

