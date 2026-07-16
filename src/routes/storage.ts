import { createReadStream, existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { Hono } from 'hono'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

const storage = new Hono<AppEnv>()

const UPLOADS_DIR = join(process.cwd(), 'uploads')
const MAX_BYTES = 10 * 1024 * 1024 // 10 MB

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
}

function r2Configured() {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_NAME
  )
}

function r2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  })
}

// POST /storage/upload?filename=photo.jpg — raw image bytes in the body.
// Stores to R2 when configured, otherwise ./uploads on disk.
// Returns { url, key } where url is publicly fetchable.
storage.post('/upload', requireAuth, async (c) => {
  const filename = c.req.query('filename') ?? 'upload.jpg'
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const contentType = CONTENT_TYPES[ext]
  if (!contentType) {
    return c.json(
      { error: `Unsupported file type .${ext} — use ${Object.keys(CONTENT_TYPES).join('/')}` },
      400
    )
  }

  const body = Buffer.from(await c.req.arrayBuffer())
  if (body.length === 0) return c.json({ error: 'Empty upload body.' }, 400)
  if (body.length > MAX_BYTES) return c.json({ error: 'File exceeds 10 MB limit.' }, 413)

  const key = `${c.get('userId')}/${Date.now()}.${ext}`

  if (r2Configured()) {
    await r2Client().send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    )
    const publicBase = process.env.R2_PUBLIC_URL?.replace(/\/$/, '')
    if (!publicBase) {
      return c.json({ error: 'R2_PUBLIC_URL is not set — enable public access on the bucket.' }, 500)
    }
    return c.json({ url: `${publicBase}/${key}`, key }, 201)
  }

  const dir = join(UPLOADS_DIR, c.get('userId'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(UPLOADS_DIR, key), body)

  const origin = new URL(c.req.url).origin
  return c.json({ url: `${origin}/storage/files/${key}`, key }, 201)
})

// GET /storage/files/:userId/:filename — serves local-disk uploads (dev mode)
storage.get('/files/:userId/:filename', async (c) => {
  const userId = c.req.param('userId')
  const filename = c.req.param('filename')
  // Path segments must be plain tokens — blocks traversal
  if (!/^[\w-]+$/.test(userId) || !/^[\w-]+\.[a-z0-9]+$/i.test(filename)) {
    return c.json({ error: 'Not found' }, 404)
  }

  const path = join(UPLOADS_DIR, userId, filename)
  if (!existsSync(path)) return c.json({ error: 'Not found' }, 404)

  const ext = filename.split('.').pop()!.toLowerCase()
  const stream = createReadStream(path)
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
})

export default storage
