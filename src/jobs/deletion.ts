import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { query } from '../db'
import {
  deletePrefix,
  feedbackStorageConfigured,
  publicStorageConfigured,
} from '../lib/r2'
import { captureException, captureMessage } from '../lib/sentry'

const UPLOADS_DIR = join(process.cwd(), 'uploads')
const FEEDBACK_DIR = join(process.cwd(), '.feedback-uploads')

async function removeJobMedia(job: {
  public_prefix: string
  feedback_prefix: string
}) {
  if (publicStorageConfigured()) {
    await deletePrefix(process.env.R2_BUCKET_NAME!, job.public_prefix)
  } else {
    await rm(join(UPLOADS_DIR, job.public_prefix), { recursive: true, force: true })
  }

  if (feedbackStorageConfigured()) {
    await deletePrefix(process.env.R2_FEEDBACK_BUCKET_NAME!, job.feedback_prefix)
  } else if (process.env.NODE_ENV !== 'production') {
    await rm(join(FEEDBACK_DIR, job.feedback_prefix), { recursive: true, force: true })
  } else {
    throw new Error('Private feedback storage is not configured')
  }
}

export async function processDeletionJobs(limit = 10): Promise<number> {
  const claimed = await query(
    `UPDATE deletion_jobs
     SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
     WHERE id IN (
       SELECT id FROM deletion_jobs
       WHERE status IN ('pending', 'failed') AND next_attempt_at <= NOW()
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     RETURNING id, public_prefix, feedback_prefix, attempts`,
    [limit]
  )
  let completed = 0
  for (const job of claimed.rows) {
    try {
      await removeJobMedia(job)
      await query(
        `UPDATE deletion_jobs
         SET status = 'complete', completed_at = NOW(), updated_at = NOW(), last_error = NULL
         WHERE id = $1`,
        [job.id]
      )
      completed++
    } catch (err: any) {
      const delayMinutes = Math.min(360, 2 ** Math.min(Number(job.attempts), 8))
      await query(
        `UPDATE deletion_jobs
         SET status = 'failed',
             next_attempt_at = NOW() + ($2::text || ' minutes')::interval,
             last_error = $3,
             updated_at = NOW()
         WHERE id = $1`,
        [job.id, delayMinutes, String(err?.message ?? err).slice(0, 500)]
      )
      console.error('[deletion] media cleanup failed:', err?.message ?? err)
      captureException(err, {
        component: 'account-media-deletion',
        job_id: job.id,
        attempts: Number(job.attempts),
      })
    }
  }
  const overdue = await query(
    `SELECT COUNT(*)::int AS count
     FROM deletion_jobs
     WHERE status <> 'complete' AND created_at < NOW() - INTERVAL '24 hours'`
  )
  const overdueCount = Number(overdue?.rows?.[0]?.count ?? 0)
  if (overdueCount > 0) {
    captureMessage('Account media deletion exceeded 24 hours', 'error', {
      overdue_jobs: overdueCount,
    })
  }
  return completed
}
