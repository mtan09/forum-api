import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import sharp from 'sharp'
import { query } from '../db'
import { moderateImage, moderationFailure } from '../lib/moderation'
import { feedbackStorageConfigured, putFeedbackObject } from '../lib/r2'
import { requireAuth } from '../middleware/auth'
import { rateLimit } from '../middleware/rateLimit'
import type { AppEnv } from '../types'

const feedback = new Hono<AppEnv>()
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024
const LOCAL_DIR = join(process.cwd(), '.feedback-uploads')
const CATEGORIES = new Set(['bug', 'ui', 'performance', 'content', 'idea', 'other'])

feedback.post(
  '/screenshot',
  requireAuth,
  rateLimit({ name: 'feedbackScreenshot', windowMs: 60 * 60_000, max: 20 }),
  async (c) => {
    const source = Buffer.from(await c.req.arrayBuffer())
    if (!source.length) return c.json({ error: 'Empty screenshot.' }, 400)
    if (source.length > MAX_SCREENSHOT_BYTES) {
      return c.json({ error: 'Screenshot exceeds 8 MB.' }, 413)
    }
    let body: Buffer
    try {
      body = await sharp(source, { failOn: 'error' })
        .rotate()
        .resize({ width: 1600, height: 2400, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer()
    } catch {
      return c.json({ error: 'That screenshot is not a valid image.' }, 400)
    }
    const moderation = await moderateImage(c.get('userId'), body, 'image/jpeg')
    const moderationError = moderationFailure(moderation)
    if (moderationError) return c.json(moderationError.body, moderationError.status)

    const key = `feedback/${c.get('userId')}/${Date.now()}.jpg`
    if (feedbackStorageConfigured()) {
      await putFeedbackObject(key, body, 'image/jpeg')
    } else if (process.env.NODE_ENV !== 'production') {
      const path = join(LOCAL_DIR, key)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, body)
    } else {
      return c.json({ error: 'Feedback screenshots are temporarily unavailable.' }, 503)
    }
    return c.json({ key }, 201)
  }
)

feedback.post(
  '/',
  requireAuth,
  rateLimit({ name: 'feedback', windowMs: 60 * 60_000, max: 20 }),
  async (c) => {
    const body = await c.req.json().catch(() => null)
    const category = String(body?.category ?? '')
    const message = String(body?.message ?? '').trim()
    const screenshotKey = body?.screenshot_key ? String(body.screenshot_key) : null
    if (!CATEGORIES.has(category)) return c.json({ error: 'Choose a valid category.' }, 400)
    if (message.length < 3 || message.length > 5000) {
      return c.json({ error: 'Feedback must be 3–5000 characters.' }, 400)
    }
    if (
      screenshotKey &&
      !screenshotKey.startsWith(`feedback/${c.get('userId')}/`)
    ) {
      return c.json({ error: 'Invalid screenshot key.' }, 400)
    }
    const metadata =
      body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? body.metadata
        : {}
    const result = await query(
      `INSERT INTO beta_feedback
         (user_id, category, message, screenshot_key, route, theme, app_version,
          build_number, platform, os_version, device_model, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, status, created_at`,
      [
        c.get('userId'),
        category,
        message,
        screenshotKey,
        body?.route ? String(body.route).slice(0, 300) : null,
        body?.theme ? String(body.theme).slice(0, 30) : null,
        body?.app_version ? String(body.app_version).slice(0, 50) : null,
        body?.build_number ? String(body.build_number).slice(0, 50) : null,
        body?.platform ? String(body.platform).slice(0, 50) : null,
        body?.os_version ? String(body.os_version).slice(0, 100) : null,
        body?.device_model ? String(body.device_model).slice(0, 100) : null,
        metadata,
      ]
    )
    return c.json(result.rows[0], 201)
  }
)

export default feedback
