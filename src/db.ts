import { Pool } from 'pg'

const rawConnectionString = process.env.DATABASE_URL
const isLocal = /localhost|127\.0\.0\.1/.test(rawConnectionString ?? '')

// SSL is configured explicitly below. Removing sslmode from the URL avoids
// pg's compatibility warning and prevents a future driver release from
// silently changing the meaning of the connection's TLS settings.
function withoutSslMode(value: string | undefined): string | undefined {
  if (!value) return value
  try {
    const url = new URL(value)
    url.searchParams.delete('sslmode')
    return url.href
  } catch {
    return value
  }
}

const connectionString = withoutSslMode(rawConnectionString)

const pool = new Pool({
  connectionString,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
})

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err)
})

export function query(text: string, params?: unknown[]) {
  return pool.query(text, params)
}

export default pool
