import 'dotenv/config'
import pool from '../db'
import { initSentry } from '../lib/sentry'
import { pruneDailyBriefs } from '../lib/daily-brief'
import { processDailyBriefDeliveries } from '../lib/daily-brief-delivery'

initSentry()

Promise.all([processDailyBriefDeliveries(200), pruneDailyBriefs()])
  .then(([processed, pruned]) => {
    console.log(`[daily-brief] processed ${processed} delivery user(s), pruned ${pruned} expired edition(s)`)
  })
  .catch((err) => {
    console.error('[daily-brief] fatal:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
