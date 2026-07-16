import { Pool } from 'pg'

const connectionString = process.env.DATABASE_URL
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString ?? '')

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
