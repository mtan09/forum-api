import 'dotenv/config'
import pool from '../db'
import { processDeletionJobs } from './deletion'
import { flushEmailDigests } from '../lib/push'

Promise.all([processDeletionJobs(50), flushEmailDigests(100)])
  .then(([deletions, emails]) => {
    console.log(`[jobs] ${deletions} deletion job(s), ${emails} email digest(s) completed`)
  })
  .catch((err) => {
    console.error('[jobs] fatal:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
