import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto'
import { promisify } from 'util'
import { sign } from 'hono/jwt'

const scrypt = promisify(scryptCb)

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days

export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET is not set — add it to .env')
  return secret
}

export function issueToken(userId: string): Promise<string> {
  return sign(
    { sub: userId, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS },
    jwtSecret()
  )
}

// Stored as scrypt:<salt b64>:<hash b64>
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = (await scrypt(password, salt, 64)) as Buffer
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split(':')
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false
  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(hashB64, 'base64')
  const actual = (await scrypt(password, salt, expected.length)) as Buffer
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
