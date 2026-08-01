import { query } from '../db'

// Bump this whenever the categories of data, provider, or purposes in the
// disclosure materially change. A new version intentionally requires a new
// decision instead of silently treating old permission as current.
export const AI_CONSENT_VERSION = '2026-07-30'

export type AIConsentStatus = 'accepted' | 'declined' | 'revoked' | 'not_asked'

export async function currentAIConsent(userId: string): Promise<{
  status: AIConsentStatus
  version: string | null
  current: boolean
  decided_at: string | null
}> {
  const result = await query(
    `SELECT status, consent_version, decided_at
     FROM ai_data_consents
     WHERE user_id = $1`,
    [userId]
  )
  const row = result.rows[0]
  const status = (row?.status ?? 'not_asked') as AIConsentStatus
  const version = row?.consent_version ?? null
  return {
    status,
    version,
    current: status === 'accepted' && version === AI_CONSENT_VERSION,
    decided_at: row?.decided_at ?? null,
  }
}

export async function hasCurrentAIConsent(userId: string): Promise<boolean> {
  return (await currentAIConsent(userId)).current
}

export async function recordAIConsent(
  userId: string,
  accepted: boolean,
  version: string
): Promise<Awaited<ReturnType<typeof currentAIConsent>>> {
  if (version !== AI_CONSENT_VERSION) {
    throw new Error('AI_CONSENT_VERSION_MISMATCH')
  }

  await query(
    `INSERT INTO ai_data_consents (user_id, consent_version, status, decided_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       consent_version = EXCLUDED.consent_version,
       status = CASE
         WHEN EXCLUDED.status = 'accepted' THEN 'accepted'
         WHEN ai_data_consents.status = 'accepted' THEN 'revoked'
         ELSE 'declined'
       END,
       decided_at = NOW()`,
    [userId, version, accepted ? 'accepted' : 'declined']
  )
  return currentAIConsent(userId)
}
