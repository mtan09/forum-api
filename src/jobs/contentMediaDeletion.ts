import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { query } from '../db'
import { deletePublicObject, publicStorageConfigured } from '../lib/r2'
import { captureException, captureMessage } from '../lib/sentry'

const UPLOADS_DIR = join(process.cwd(), 'uploads')
const SAFE_OBJECT_KEY = /^[\w-]+\/[\w-]+\.(?:jpe?g|png|webp|gif|heic|heif)$/i

async function removeObject(key: string) {
  if (!SAFE_OBJECT_KEY.test(key)) throw new Error(`Refusing unsafe media object key: ${key}`)
  if (publicStorageConfigured()) {
    await deletePublicObject(key)
  } else {
    await rm(join(UPLOADS_DIR, key), { force: true })
  }
}

export async function processMediaDeletionJobs(limit = 25): Promise<number> {
  const claimed = await query(
    `UPDATE media_deletion_jobs
     SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
     WHERE id IN (
       SELECT id FROM media_deletion_jobs
       WHERE (status IN ('pending', 'failed') AND next_attempt_at <= NOW())
          OR (status = 'processing' AND updated_at <= NOW() - INTERVAL '15 minutes')
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     RETURNING id, object_key, attempts`,
    [limit]
  )

  let completed = 0
  for (const job of claimed.rows) {
    try {
      await removeObject(String(job.object_key))
      await query(
        `UPDATE media_deletion_jobs
         SET status = 'complete', completed_at = NOW(), updated_at = NOW(), last_error = NULL
         WHERE id = $1`,
        [job.id]
      )
      completed++
    } catch (err: any) {
      const delayMinutes = Math.min(360, 2 ** Math.min(Number(job.attempts), 8))
      await query(
        `UPDATE media_deletion_jobs
         SET status = 'failed',
             next_attempt_at = NOW() + ($2::text || ' minutes')::interval,
             last_error = $3,
             updated_at = NOW()
         WHERE id = $1`,
        [job.id, delayMinutes, String(err?.message ?? err).slice(0, 500)]
      )
      captureException(err, {
        component: 'post-media-deletion',
        job_id: job.id,
        attempts: Number(job.attempts),
      })
    }
  }

  const overdue = await query(
    `SELECT COUNT(*)::int AS count
     FROM media_deletion_jobs
     WHERE status <> 'complete' AND created_at < NOW() - INTERVAL '24 hours'`
  )
  const overdueCount = Number(overdue.rows[0]?.count ?? 0)
  if (overdueCount > 0) {
    captureMessage('Post media deletion exceeded 24 hours', 'error', {
      overdue_jobs: overdueCount,
    })
  }
  return completed
}
