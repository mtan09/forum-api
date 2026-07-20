// CLI entry: `npm run ingest`
import 'dotenv/config'
import pool from '../db'
import { runIngest } from './pipeline'

runIngest()
  .catch((err) => {
    console.error('[ingest] fatal:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
