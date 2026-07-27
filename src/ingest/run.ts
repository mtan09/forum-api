// CLI entry: `npm run ingest`
import 'dotenv/config'
import pool from '../db'
import { runIngest } from './pipeline'
import { initSentry } from '../lib/sentry'

initSentry()

async function warmDatabase(attempts = 6) {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (err) {
      lastError = err
      if (attempt === attempts) break
      const delay = Math.min(15_000, 1000 * 2 ** (attempt - 1))
      console.warn(`[ingest] database wake-up attempt ${attempt} failed; retrying in ${delay}ms`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

warmDatabase()
  .then(() => runIngest())
  .catch((err) => {
    console.error('[ingest] fatal:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
