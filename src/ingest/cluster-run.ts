// CLI entry: `npm run cluster` — re-cluster recent articles/posts into
// hot topics without a full ingest pass.
import 'dotenv/config'
import pool from '../db'
import { clusterAndPublish } from './cluster'

clusterAndPublish()
  .then(({ hot }) => {
    for (const title of hot) console.log(`  • ${title}`)
  })
  .catch((err) => {
    console.error('[cluster] fatal:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
