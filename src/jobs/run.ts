import 'dotenv/config'
import pool from '../db'
import { processDeletionJobs } from './deletion'
import { processMediaDeletionJobs } from './contentMediaDeletion'
import { flushEmailDigests, processPushReceipts } from '../lib/push'

Promise.all([
  processDeletionJobs(50),
  processMediaDeletionJobs(100),
  flushEmailDigests(100),
  processPushReceipts(1000),
])
  .then(([deletions, mediaDeletions, emails, receipts]) => {
    console.log(
      `[jobs] ${deletions} account deletion job(s), ${mediaDeletions} media deletion job(s), ` +
      `${emails} email digest(s), ` +
      `${receipts.checked} push receipt(s) checked`
    )
  })
  .catch((err) => {
    console.error('[jobs] fatal:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
