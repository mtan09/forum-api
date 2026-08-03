import 'dotenv/config'
import pool from '../db'
import { initSentry } from '../lib/sentry'
import { runDemoActivity } from './activity'

initSentry()

runDemoActivity(Number(process.env.DEMO_ACTIVITY_BATCH_SIZE ?? 20))
  .catch((error) => {
    console.error('[demo] activity run failed:', error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
