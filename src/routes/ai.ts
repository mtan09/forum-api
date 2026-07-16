import Anthropic from '@anthropic-ai/sdk'
import { Hono } from 'hono'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

const ai = new Hono<AppEnv>()

const RESPONSE_SCHEMA = {
  type: 'object' as const,
  properties: {
    left: { type: 'string' as const, description: 'The answer from a left-leaning perspective' },
    center: { type: 'string' as const, description: 'The answer from a centrist perspective' },
    right: { type: 'string' as const, description: 'The answer from a right-leaning perspective' },
  },
  required: ['left', 'center', 'right'],
  additionalProperties: false,
}

// POST /ai/chat  { message: string, framing?: string }
// Returns { left, center, right } — one answer per political perspective.
ai.post('/chat', requireAuth, async (c) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return c.json(
      { error: 'AI chat is not configured — set ANTHROPIC_API_KEY in the server .env.' },
      503
    )
  }

  const body = await c.req.json().catch(() => null)
  const message = String(body?.message ?? '').trim()
  const framing = String(body?.framing ?? 'General Audience')
  if (!message) return c.json({ error: 'message is required.' }, 400)

  const client = new Anthropic()
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4096,
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
    },
    system: `You are forumAI, the assistant inside a political discussion app. For each user question, produce three self-contained answers to the same question: one as a thoughtful person on the political left would frame it, one as a political centrist would, and one as a thoughtful person on the political right would. Each answer should present that perspective's strongest good-faith reasoning — never a caricature — and note where the perspectives agree. Explain at the level of a "${framing}" audience: adjust vocabulary, depth, and assumed background knowledge accordingly. Keep each answer to 2-4 short paragraphs.`,
    messages: [{ role: 'user', content: message }],
  })

  if (response.stop_reason === 'refusal') {
    return c.json({ error: 'forumAI declined to answer this question.' }, 422)
  }

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  try {
    const parsed = JSON.parse(text)
    return c.json({ left: parsed.left, center: parsed.center, right: parsed.right })
  } catch {
    return c.json({ error: 'AI returned an unparseable response — try again.' }, 502)
  }
})

export default ai
