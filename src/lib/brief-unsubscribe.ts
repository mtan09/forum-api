import { createHmac, timingSafeEqual } from 'node:crypto'
import { jwtSecret } from './auth'

const PURPOSE = 'daily-brief-email'
/** Bump to invalidate every issued link without touching session signing. */
const VERSION = 1
/** Links in old email stay valid this long. Longer than retention on purpose:
 *  an unsubscribe link must outlive the edition that carried it. */
const MAX_AGE_DAYS = 180

/**
 * Signing key for unsubscribe links.
 *
 * Prefers a dedicated secret and falls back to the session secret so existing
 * deployments keep working. The fallback is not ideal and is worth retiring:
 * rotating JWT_SECRET is a routine credential operation, but it silently
 * invalidates every unsubscribe link already sitting in a user's inbox, and a
 * one-click unsubscribe that returns "invalid link" is a deliverability
 * signal to Gmail and Yahoo as well as a compliance problem. Set
 * BRIEF_UNSUBSCRIBE_SECRET so the two can be rotated independently.
 */
function signingKey(): string {
  return process.env.BRIEF_UNSUBSCRIBE_SECRET || jwtSecret()
}

const sign = (body: string) =>
  createHmac('sha256', signingKey()).update(body).digest()

export function dailyBriefUnsubscribeToken(userId: string): string {
  const body = Buffer.from(JSON.stringify({
    sub: userId,
    purpose: PURPOSE,
    v: VERSION,
    iat: Math.floor(Date.now() / 1000),
  })).toString('base64url')
  return `${body}.${sign(body).toString('base64url')}`
}

export function verifyDailyBriefUnsubscribeToken(token: string): string | null {
  const [body, signature] = token.split('.')
  if (!body || !signature) return null

  // Verify the signature before parsing anything out of the body, so a forged
  // payload is never interpreted.
  const expected = sign(body)
  let supplied: Buffer
  try {
    supplied = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (parsed?.purpose !== PURPOSE || typeof parsed?.sub !== 'string') return null
    if (parsed?.v !== VERSION) return null
    // Tokens issued before iat existed have no timestamp; accept them so the
    // upgrade does not break links already in flight.
    if (typeof parsed?.iat === 'number') {
      const ageDays = (Date.now() / 1000 - parsed.iat) / 86400
      if (ageDays > MAX_AGE_DAYS || ageDays < -1) return null
    }
    return parsed.sub
  } catch {
    return null
  }
}
