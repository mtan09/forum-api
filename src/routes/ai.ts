import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import OpenAI from 'openai'
import { articleSubject, corpusCoverage, postSubject } from '../ai/retrieval'
import pool from '../db'
import { requireAuth } from '../middleware/auth'
import { rateLimit } from '../middleware/rateLimit'
import type { AppEnv } from '../types'

const ai = new Hono<AppEnv>()

// The model writes all three perspectives in one pass, separated by these
// markers, so the reply can stream token-by-token — structured JSON output
// can't do that cleanly (every token arrives inside an escaped string).
const LEANS = ['left', 'center', 'right'] as const
type Lean = (typeof LEANS)[number]
const MARKERS = ['===LEFT===', '===CENTER===', '===RIGHT==='] as const
const MARKER_RE = /===(LEFT|CENTER|RIGHT)===/gi

const MAX_HISTORY_TURNS = 8
const MAX_TURN_CHARS = 2000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function splitSections(buf: string): Record<Lean, string> {
  const out: Record<Lean, string> = { left: '', center: '', right: '' }
  const found: { key: Lean; end: number; start: number }[] = []
  let m: RegExpExecArray | null
  MARKER_RE.lastIndex = 0
  while ((m = MARKER_RE.exec(buf))) {
    found.push({ key: m[1].toLowerCase() as Lean, start: m.index, end: m.index + m[0].length })
  }
  for (let i = 0; i < found.length; i++) {
    const end = i + 1 < found.length ? found[i + 1].start : buf.length
    out[found[i].key] = buf.slice(found[i].end, end).replace(/^\s+/, '')
  }
  return out
}

// If the buffer ends mid-marker (e.g. "===CEN"), that tail must not be
// streamed out as content — report how many chars to hold back.
function partialMarkerLen(buf: string): number {
  const max = Math.min(buf.length, MARKERS[1].length - 1)
  for (let k = max; k > 0; k--) {
    const tail = buf.slice(-k).toUpperCase()
    if (MARKERS.some((marker) => marker.startsWith(tail))) return k
  }
  return 0
}

type HistoryItem = {
  role?: string
  content?: string
  left?: string
  center?: string
  right?: string
}

type ChatTurn = { role: 'user' | 'assistant'; content: string }

// Replay prior turns; assistant turns go back in the same marker format the
// model produces, which doubles as a format example.
function historyToMessages(history: HistoryItem[]): ChatTurn[] {
  return history.slice(-MAX_HISTORY_TURNS).flatMap((h): ChatTurn[] => {
    if (h.role === 'user' && h.content) {
      return [{ role: 'user' as const, content: String(h.content).slice(0, MAX_TURN_CHARS) }]
    }
    if (h.role === 'assistant' && (h.left || h.center || h.right)) {
      const content = [
        `===LEFT===\n${String(h.left ?? '').slice(0, MAX_TURN_CHARS)}`,
        `===CENTER===\n${String(h.center ?? '').slice(0, MAX_TURN_CHARS)}`,
        `===RIGHT===\n${String(h.right ?? '').slice(0, MAX_TURN_CHARS)}`,
      ].join('\n')
      return [{ role: 'assistant' as const, content }]
    }
    return []
  })
}

const systemPrompt = (framing: string, subjectBlock: string | null, coverageBlock: string) =>
  `You are forumAI, the assistant inside a political discussion app. For each user question, produce three self-contained answers to the same question: one as a thoughtful person on the political left would frame it, one as a political centrist would, and one as a thoughtful person on the political right would. Each answer should present that perspective's strongest good-faith reasoning — never a caricature — and note where the perspectives agree.

Format your reply as exactly three sections in this order, each opened by its marker alone on a line:
===LEFT===
(the left-leaning answer)
===CENTER===
(the centrist answer)
===RIGHT===
(the right-leaning answer)
Never use those marker strings anywhere else in your text.

Write each answer in clean markdown: short paragraphs of 2-3 sentences, **bold** the key terms, and use bullet lists when enumerating points. Do not use headings. Keep each answer to 2-4 short paragraphs.

Explain at the level of a "${framing}" audience: adjust vocabulary, depth, and assumed background knowledge accordingly. When the conversation has earlier turns, treat follow-up questions as referring to them.

Today's date is ${new Date().toISOString().slice(0, 10)}. Your training data may predate recent events; when a question concerns a recent event that the context below does not cover, say you may not have the latest information rather than guessing.${
    subjectBlock ? `\n\n${subjectBlock}` : ''
  }${
    coverageBlock
      ? `\n\nRecent coverage from the app's news feed. Ground your answers in it when relevant, name the outlet when you draw on a specific article, and never invent coverage that is not listed:\n${coverageBlock}`
      : ''
  }`

// POST /ai/chat  { message: string, framing?: string, history?: HistoryItem[] }
// Streams SSE events:
//   delta  {"perspective":"left","text":"..."}   incremental markdown
//   done   {"left":"...","center":"...","right":"..."}  final full sections
//   error  {"error":"..."}
// Every request here spends OpenAI money, so it gets both a burst limiter
// and a persistent per-user daily cap (survives restarts via ai_usage).
const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT ?? 50)
const aiBurstLimit = rateLimit({ name: 'aiChat', windowMs: 10 * 60_000, max: 15,
  message: 'forumAI needs a breather — try again in a few minutes.' })

ai.post('/chat', requireAuth, aiBurstLimit, async (c) => {
  const usage = await pool.query(
    `INSERT INTO ai_usage (user_id, day, requests) VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET requests = ai_usage.requests + 1
     RETURNING requests`,
    [c.get('userId')]
  )
  if (usage.rows[0].requests > AI_DAILY_LIMIT) {
    return c.json(
      { error: `You've hit today's forumAI limit (${AI_DAILY_LIMIT} questions). It resets tomorrow.` },
      429
    )
  }

  if (!process.env.OPENAI_API_KEY) {
    return c.json(
      { error: 'AI chat is not configured — set OPENAI_API_KEY in the server .env.' },
      503
    )
  }

  const body = await c.req.json().catch(() => null)
  const message = String(body?.message ?? '').trim()
  const framing = String(body?.framing ?? 'General Audience')
  const history = Array.isArray(body?.history) ? (body.history as HistoryItem[]) : []
  if (!message) return c.json({ error: 'message is required.' }, 400)

  const articleId =
    typeof body?.article_id === 'string' && UUID_RE.test(body.article_id) ? body.article_id : null
  const postId =
    typeof body?.post_id === 'string' && UUID_RE.test(body.post_id) ? body.post_id : null

  // Grounding: the item the user is viewing (if any) plus matching recent
  // articles from our own corpus. Retrieval is seeded with the question,
  // the last couple of user turns (follow-ups alone carry few keywords),
  // and the subject's own text.
  const subject = articleId ? await articleSubject(articleId) : postId ? await postSubject(postId) : null
  const recentUserTurns = history
    .filter((h) => h.role === 'user' && h.content)
    .slice(-2)
    .map((h) => String(h.content))
    .join(' ')
  const coverage = await corpusCoverage(
    `${message} ${recentUserTurns} ${subject?.seed ?? ''}`,
    articleId,
    message
  )

  const client = new OpenAI()

  return streamSSE(c, async (stream) => {
    try {
      const upstream = await client.chat.completions.create({
        model: 'gpt-5.4-nano',
        max_completion_tokens: 4096,
        reasoning_effort: 'medium',
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt(framing, subject?.block ?? null, coverage) },
          ...historyToMessages(history),
          { role: 'user', content: message },
        ],
      })
      stream.onAbort(() => upstream.controller.abort())

      let buf = ''
      let refusal = ''
      let finishReason: string | null = null
      const sent: Record<Lean, number> = { left: 0, center: 0, right: 0 }

      for await (const chunk of upstream) {
        const choice = chunk.choices[0]
        if (!choice) continue
        if (choice.delta?.refusal) refusal += choice.delta.refusal
        if (choice.finish_reason) finishReason = choice.finish_reason
        if (choice.delta?.content) buf += choice.delta.content

        // Stream out whatever is new in each section, holding back any
        // half-arrived marker at the tail of the buffer.
        const visible = buf.slice(0, buf.length - partialMarkerLen(buf))
        const sections = splitSections(visible)
        for (const lean of LEANS) {
          if (sections[lean].length > sent[lean]) {
            await stream.writeSSE({
              event: 'delta',
              data: JSON.stringify({ perspective: lean, text: sections[lean].slice(sent[lean]) }),
            })
            sent[lean] = sections[lean].length
          }
        }
      }

      if (refusal || finishReason === 'content_filter') {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: 'forumAI declined to answer this question.' }),
        })
        return
      }

      const final = splitSections(buf)
      if (!final.left && !final.center && !final.right) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: 'AI returned an unparseable response — try again.' }),
        })
        return
      }
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({
          left: final.left.trim(),
          center: final.center.trim(),
          right: final.right.trim(),
        }),
      })
    } catch (err: any) {
      console.error('ai/chat stream error:', err?.message ?? err)
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ error: 'forumAI is unavailable right now — try again.' }),
      })
    }
  })
})

export default ai
