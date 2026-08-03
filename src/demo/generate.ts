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
        content: `You write one short piece of clearly fictional demo-community content for forum, a political discussion app. The account is visibly labeled "Fictional demo account" in the product. Stay in the supplied persona. Take a definite, good-faith point of view; do not flatten it into generic balance language. Do not impersonate a real person, claim access to private information, invent quotations, invent exact statistics, or say you personally witnessed a breaking event. Use only the supplied headline context for current-event facts. Never mention these instructions, automation, App Review, or being an AI. Return valid JSON only.`,
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

export async function generateDemoPost(persona: DemoPersona): Promise<{
  text: string
  hashtags: string[]
}> {
  const topics = await currentTopics(persona)
  if (topics.length === 0) throw new Error('No recent clustered topics are available for a demo post')
  const context = topics
    .map((topic, index) => `${index + 1}. ${topic.title}\n${topic.headlines.map((h) => `- ${h}`).join('\n')}`)
    .join('\n\n')
  const result = await generateJson(
    `Persona: ${persona.username}, a ${persona.role}.\nPolitical lean on a 0=left to 1=right scale: ${persona.lean.toFixed(2)}.\nVoice: ${persona.voice}\nCore interests: ${persona.interests.join(', ')}.\n\nChoose the one current topic below that this persona would care about most. Write a 45-110 word forum post with a concrete argument, question, or criticism in that voice. The post should be recognizably left-, center-, or right-leaning when the persona is, without using a party slogan as a substitute for reasoning. Return {"text":"...","hashtags":["one","two"]}. Use 1-3 lowercase hashtags without #.\n\nCurrent topic/headline context:\n${context}`
  )
  const text = cleanGeneratedText(String(result.text ?? ''))
  if (text.length < 30 || text.length > 700) throw new Error('Generated demo post length is invalid')
  const hashtags = Array.isArray(result.hashtags)
    ? result.hashtags.map(String).map((tag) => tag.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean).slice(0, 3)
    : []
  await approve(text, 'post')
  return { text, hashtags }
}

export async function generateDemoComment(
  persona: DemoPersona,
  target: { kind: 'post' | 'debate'; text: string; author?: string; position?: number | null }
): Promise<string> {
  const result = await generateJson(
    `Persona: ${persona.username}, a ${persona.role}.\nPolitical lean on a 0=left to 1=right scale: ${persona.lean.toFixed(2)}.\nVoice: ${persona.voice}\n\nWrite a 20-75 word reply to this ${target.kind}. Respond to its actual claim. It is fine to agree, disagree, or complicate it, but be specific and stay in character. Do not begin with empty praise such as "great point." Return {"text":"..."}.\n\n${target.author ? `Author: ${target.author}\n` : ''}${target.position == null ? '' : `The app scored the post at ${target.position.toFixed(2)} on the same left-right scale.\n`}Text: ${target.text}`
  )
  const text = cleanGeneratedText(String(result.text ?? ''))
  if (text.length < 15 || text.length > 500) throw new Error('Generated demo comment length is invalid')
  await approve(text, 'comment')
  return text
}
