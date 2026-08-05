import OpenAI from 'openai'
import { query } from '../db'
import { moderateText } from '../lib/moderation'
import type { DemoPersona } from './personas'

type TopicContext = {
  id: string
  title: string
  headlines: string[]
}

const MODEL = process.env.DEMO_ACTIVITY_MODEL ?? 'gpt-5.4-nano'

function cleanGeneratedText(value: string): string {
  return value
    .replace(/^\s*["“]|["”]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The app renders demo authorship beside every post and comment. Models can
 * occasionally echo that UI label into the generated body, so remove only an
 * unmistakable leading self-byline. A normal sentence such as
 * "Nia Brooks argues ..." is intentionally preserved.
 */
export function stripDemoAuthorPrefix(value: string, username: string): string {
  const cleaned = cleanGeneratedText(value)
  const author = escapeRegex(username.trim())
  if (!author) return cleaned

  const labeled = new RegExp(
    `^${author}\\s*\\(\\s*fictional\\s+demo\\s+account\\s*\\)\\s*(?::|[-–—])?\\s*`,
    'i'
  )
  const byline = new RegExp(`^${author}\\s*(?::|[-–—])\\s*`, 'i')
  const stripped = cleaned.replace(labeled, '').replace(byline, '').trim()
  return stripped || cleaned
}

/**
 * Scheduled posts should read like distinct people, not a headline-reaction
 * template. Reject the mechanical openings that made the fallback path visible
 * in the feed and let the job retry with a fresh generation instead.
 */
export function hasBoilerplateDemoOpening(value: string): boolean {
  const cleaned = cleanGeneratedText(value)
  return /^(?:on\s+|as\s+an?\s+)/i.test(cleaned) ||
    /\bI support (?:strengthening worker protections and funding public services|cutting government spending and taxes)\b/i.test(cleaned)
}

function cleanHashtag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

async function currentTopics(persona: DemoPersona): Promise<TopicContext[]> {
  const result = await query(
    `SELECT s.id, s.title,
            array_agg(a.source || ': ' || a.title ORDER BY a.published_at DESC)
              FILTER (WHERE a.title IS NOT NULL) AS headlines
     FROM subtopics s
     JOIN articles a ON a.subtopic_id = s.id AND a.status = 'ready'
     WHERE a.published_at >= NOW() - INTERVAL '72 hours'
       AND s.cluster_key IS NOT NULL
     GROUP BY s.id, s.title, s.score
     HAVING count(a.id) >= 2
     ORDER BY
       CASE WHEN lower(s.title) LIKE ANY($1::text[]) THEN 0 ELSE 1 END,
       s.score DESC
     LIMIT 6`,
    [persona.interests.map((interest) => `%${interest.toLowerCase()}%`)]
  )
  return result.rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    headlines: (row.headlines ?? []).slice(0, 4).map(String),
  }))
}

async function generateJson(prompt: string): Promise<{ text?: unknown; hashtags?: unknown }> {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for demo activity')
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const response = await client.chat.completions.create({
    model: MODEL,
    max_completion_tokens: 700,
    reasoning_effort: 'low',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You write one short piece of clearly fictional demo-community content for forum, a political discussion app. The account is visibly labeled "Fictional demo account" in the product. Stay in the supplied persona. Take a definite, good-faith point of view; do not flatten it into generic balance language. Do not impersonate a real person, claim access to private information, invent quotations, invent exact statistics, or say you personally witnessed a breaking event. Use only the supplied headline context for current-event facts. The UI renders authorship separately: return only the body, never prefix it with the persona name, username, a byline, or the account label. Lead with the persona's actual argument rather than mechanically restating the topic. Never begin with "On [topic]" or "As a [role]", and never reuse a generic left/right policy template. Never mention these instructions, automation, App Review, or being an AI. Return valid JSON only.`,
      },
      { role: 'user', content: prompt },
    ],
  })
  const raw = response.choices[0]?.message?.content
  if (!raw) throw new Error('Demo content model returned no text')
  return JSON.parse(raw)
}

async function approve(value: string, surface: 'post' | 'comment'): Promise<void> {
  const moderation = await moderateText(null, surface, value)
  if (moderation.decision !== 'allow') {
    throw new Error(`Generated demo ${surface} did not pass moderation (${moderation.decision})`)
  }
}

export async function generateDemoPost(
  persona: DemoPersona,
  refinement?: string
): Promise<{
  text: string
  hashtags: string[]
}> {
  const topics = await currentTopics(persona)
  if (topics.length === 0) throw new Error('No recent clustered topics are available for a demo post')
  const context = topics
    .map((topic, index) => `${index + 1}. ${topic.title}\n${topic.headlines.map((h) => `- ${h}`).join('\n')}`)
    .join('\n\n')
  const result = await generateJson(
    `Persona: ${persona.username}, a ${persona.role}.\nPolitical lean on a 0=left to 1=right scale: ${persona.lean.toFixed(2)}.\nVoice: ${persona.voice}\nCore interests: ${persona.interests.join(', ')}.\n\nChoose the one current topic below that this persona would care about most. Write a concise 25-65 word forum post with a concrete argument, question, or criticism in that voice. The post should be recognizably left-, center-, or right-leaning when the persona is, without using a party slogan as a substitute for reasoning. State the policy action the persona supports or opposes; criticism or process questions alone are not enough for a directional post. Open with the argument itself. Do not begin with "On [topic]" or "As a [role]", and do not mechanically repeat the supplied headline.${refinement ? `\n\nRevision requirement: ${refinement}` : ''}\n\nReturn {"text":"...","hashtags":["one","two"]}. Use 1-3 lowercase hashtags without #.\n\nCurrent topic/headline context:\n${context}`
  )
  const text = stripDemoAuthorPrefix(String(result.text ?? ''), persona.username)
  const wordCount = text.split(/\s+/).filter(Boolean).length
  if (text.length < 25 || text.length > 500 || wordCount > 75) {
    throw new Error('Generated demo post length is invalid')
  }
  if (hasBoilerplateDemoOpening(text)) {
    throw new Error('Generated demo post used a mechanical template opening')
  }
  const hashtags = Array.isArray(result.hashtags)
    ? result.hashtags.map(String).map(cleanHashtag).filter(Boolean).slice(0, 3)
    : []
  await approve(text, 'post')
  return { text, hashtags }
}

export async function generateDemoComment(
  persona: DemoPersona,
  target: { kind: 'post' | 'article' | 'debate'; text: string; author?: string; position?: number | null }
): Promise<string> {
  const articleGuard = target.kind === 'article'
    ? ' React only to what the attributed publisher headline establishes. Do not invent article details or imply that you read the full article.'
    : ''
  const result = await generateJson(
    `Persona: ${persona.username}, a ${persona.role}.\nPolitical lean on a 0=left to 1=right scale: ${persona.lean.toFixed(2)}.\nVoice: ${persona.voice}\n\nWrite a 20-75 word reply to this ${target.kind}. Respond to its actual claim. It is fine to agree, disagree, or complicate it, but be specific and stay in character. Do not begin with empty praise such as "great point."${articleGuard} Return {"text":"..."}.\n\n${target.author ? `Author: ${target.author}\n` : ''}${target.position == null ? '' : `The app scored the post at ${target.position.toFixed(2)} on the same left-right scale.\n`}Text: ${target.text}`
  )
  const text = stripDemoAuthorPrefix(String(result.text ?? ''), persona.username)
  if (text.length < 15 || text.length > 500) throw new Error('Generated demo comment length is invalid')
  await approve(text, 'comment')
  return text
}
