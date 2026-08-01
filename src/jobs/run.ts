import 'dotenv/config'
import pool from '../db'
import { processDeletionJobs } from './deletion'
import { flushEmailDigests, processPushReceipts } from '../lib/push'

Promise.all([processDeletionJobs(50), flushEmailDigests(100), processPushReceipts(1000)])
  .then(([deletions, emails, receipts]) => {
    console.log(
      `[jobs] ${deletions} deletion job(s), ${emails} email digest(s), ` +
      `${receipts.checked} push receipt(s) checked`
    )
  })
  .catch((err) => {
    console.error('[jobs] fatal:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
