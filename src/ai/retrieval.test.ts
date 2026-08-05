import { describe, expect, it } from 'vitest'
import { coverageIntent } from './retrieval'

describe('forumAI corpus search routing', () => {
  it.each([
    ["Explain today's biggest story without the spin.", 'top_story'],
    ['What is the top news story right now?', 'top_story'],
    ["What's happening today?", 'latest'],
    ["Give me the latest headlines.", 'latest'],
    ['What are the hottest topics today?', 'latest'],
    ["What are today's hot political topics?", 'latest'],
    ["What's trending in politics right now?", 'latest'],
    ["What context is missing from today's political coverage?", 'latest'],
    ['Which policy debate matters most right now?', 'top_story'],
    ['What are both sides missing about housing costs?', 'relevance'],
    ['How is Congress approaching war powers in Iran?', 'relevance'],
  ] as const)('routes %s to %s search', (prompt, intent) => {
    expect(coverageIntent(prompt)).toBe(intent)
  })
})
