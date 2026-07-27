import { createHash } from 'node:crypto'
import OpenAI from 'openai'
import { query } from '../db'

export type ModerationSurface =
  | 'post'
  | 'comment'
  | 'dm'
  | 'username'
  | 'bio'
  | 'forumai_prompt'
  | 'image'

export type ModerationDecision = {
  decision: 'allow' | 'reject' | 'review' | 'unavailable'
  provider: 'rules' | 'openai'
  model?: string
  categories: string[]
  metadata?: Record<string, string | number | boolean>
}

type AuditTarget = { kind: string; id: string }

type ModerationOptions = {
  target?: AuditTarget
  provider?: (input: string | Array<Record<string, unknown>>) => Promise<{
    flagged: boolean
    categories: string[]
    model?: string
  }>
  audit?: boolean
  reviewFlagged?: boolean
}

const MODEL = 'omni-moderation-latest'

const TARGETED_SLURS = [
  /\b(?:k[i1]ke|sp[i1]c|ch[i1]nk|wetback)\b/i,
  /\b(?:f[a@]ggot|tr[a@]nny)\b/i,
  /\bn[i1]gg(?:er|a)\b/i,
]

const HARD_STOP_RULES: Array<{ category: string; test: (value: string) => boolean }> = [
  {
    category: 'threat',
    test: (value) =>
      /\b(?:i|we)\s+(?:will|shall|am going to|are going to|gonna)\s+(?:kill|shoot|stab|bomb|burn)\s+(?:you|him|her|them|your|their)\b/i.test(
        value
      ),
  },
  {
    category: 'targeted_slur',
    test: (value) =>
      TARGETED_SLURS.some((pattern) => pattern.test(value)) &&
      /\b(?:you|they|them|he|she|people|all)\b/i.test(value),
  },
  {
    category: 'sexual_minors',
    test: (value) =>
      /\b(?:child|minor|underage|kid|preteen)\b.{0,45}\b(?:sex|sexual|nude|naked|porn)\b/i.test(value) ||
      /\b(?:sex|sexual|nude|naked|porn)\b.{0,45}\b(?:child|minor|underage|kid|preteen)\b/i.test(value),
  },
  {
    category: 'doxxing',
    test: (value) =>
      /\b(?:ssn|social security(?: number)?|home address|credit card(?: number)?)\s*(?:is|:|-)\s*[\d-]{8,}\b/i.test(
        value
      ),
  },
  {
    category: 'spam',
    test: (value) =>
      (value.match(/https?:\/\/\S+/gi)?.length ?? 0) >= 4 ||
      /(.)\1{19,}/i.test(value) ||
      /\b(.{12,80})\s+\1\s+\1\b/i.test(value),
  },
]

export function deterministicCategories(value: string): string[] {
  const normalized = value.normalize('NFKC').trim()
  if (!normalized) return []
  return HARD_STOP_RULES.filter((rule) => rule.test(normalized)).map((rule) => rule.category)
}

function inputHash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function openAIModerate(input: string | Array<Record<string, unknown>>) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured')
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const response = await client.moderations.create({
    model: MODEL,
    input: input as any,
  })
  const result = response.results[0]
  const categories = Object.entries(result?.categories ?? {})
    .filter(([, flagged]) => flagged)
    .map(([category]) => category)
  return { flagged: !!result?.flagged, categories, model: response.model }
}

async function recordAudit(
  userId: string | null,
  surface: ModerationSurface,
  hash: string,
  result: ModerationDecision,
  target?: AuditTarget
) {
  try {
    await query(
      `INSERT INTO moderation_audits
         (user_id, surface, input_hash, decision, provider, model, categories, metadata,
          target_kind, target_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        userId,
        surface,
        hash,
        result.decision,
        result.provider,
        result.model ?? null,
        result.categories,
        result.metadata ?? {},
        target?.kind ?? null,
        target?.id ?? null,
      ]
    )
  } catch (err: any) {
    // Audit storage must not turn an allowed request into a user-facing
    // outage. The central logger/Sentry integration still records the fault.
    console.error('[moderation] audit write failed:', err?.message ?? err)
  }
}

export async function moderateText(
  userId: string | null,
  surface: Exclude<ModerationSurface, 'image'>,
  value: string,
  options: ModerationOptions = {}
): Promise<ModerationDecision> {
  const hash = inputHash(value)
  const hardStops = deterministicCategories(value)
  if (hardStops.length > 0) {
    const result: ModerationDecision = {
      decision: options.reviewFlagged ? 'review' : 'reject',
      provider: 'rules',
      categories: hardStops,
      metadata: {
        input_characters: value.length,
        deterministic_rule_count: hardStops.length,
      },
    }
    if (options.audit !== false) await recordAudit(userId, surface, hash, result, options.target)
    return result
  }

  try {
    const providerResult = await (options.provider ?? openAIModerate)(value)
    const result: ModerationDecision = {
      decision: providerResult.flagged
        ? options.reviewFlagged
          ? 'review'
          : 'reject'
        : 'allow',
      provider: 'openai',
      model: providerResult.model ?? MODEL,
      categories: providerResult.categories,
      metadata: {
        input_characters: value.length,
        provider_flagged: providerResult.flagged,
      },
    }
    if (options.audit !== false) await recordAudit(userId, surface, hash, result, options.target)
    return result
  } catch (err: any) {
    console.error('[moderation] provider unavailable:', err?.message ?? err)
    const result: ModerationDecision = {
      decision: 'unavailable',
      provider: 'openai',
      model: MODEL,
      categories: [],
      metadata: { input_characters: value.length },
    }
    if (options.audit !== false) await recordAudit(userId, surface, hash, result, options.target)
    return result
  }
}

export async function moderateImage(
  userId: string,
  bytes: Buffer,
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp',
  options: ModerationOptions = {}
): Promise<ModerationDecision> {
  const hash = inputHash(bytes)
  const dataUrl = `data:${mimeType};base64,${bytes.toString('base64')}`
  try {
    const providerResult = await (options.provider ?? openAIModerate)([
      { type: 'image_url', image_url: { url: dataUrl } },
    ])
    const result: ModerationDecision = {
      decision: providerResult.flagged ? 'reject' : 'allow',
      provider: 'openai',
      model: providerResult.model ?? MODEL,
      categories: providerResult.categories,
      metadata: {
        input_bytes: bytes.length,
        content_type: mimeType,
        provider_flagged: providerResult.flagged,
      },
    }
    if (options.audit !== false) await recordAudit(userId, 'image', hash, result, options.target)
    return result
  } catch (err: any) {
    console.error('[moderation] image provider unavailable:', err?.message ?? err)
    const result: ModerationDecision = {
      decision: 'unavailable',
      provider: 'openai',
      model: MODEL,
      categories: [],
      metadata: { input_bytes: bytes.length, content_type: mimeType },
    }
    if (options.audit !== false) await recordAudit(userId, 'image', hash, result, options.target)
    return result
  }
}

export function moderationFailure(result: ModerationDecision) {
  if (result.decision === 'reject') {
    return {
      status: 422 as const,
      body: {
        code: 'CONTENT_REJECTED',
        error: 'This could not be shared. Please revise it and try again.',
      },
    }
  }
  if (result.decision === 'unavailable') {
    return {
      status: 503 as const,
      body: {
        code: 'MODERATION_UNAVAILABLE',
        error: 'Safety checks are temporarily unavailable. Please try again shortly.',
        retryable: true,
      },
    }
  }
  return null
}
