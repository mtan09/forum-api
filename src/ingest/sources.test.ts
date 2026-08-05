import { describe, expect, it } from 'vitest'
import {
  AI_CONTEXT_ALLOWED_SOURCES,
  AI_CONTEXT_BLOCKED_SOURCES,
  SOURCES,
  sourceAllowsAiContext,
  sourcePolicyDecision,
} from './sources'

describe('publisher forumAI policy', () => {
  it.each([...AI_CONTEXT_BLOCKED_SOURCES])('blocks %s from OpenAI context', (source) => {
    expect(sourceAllowsAiContext(source)).toBe(false)
  })

  it('allows a reviewed source without an explicit AI restriction', () => {
    expect(sourceAllowsAiContext('The Independent')).toBe(true)
  })

  it('requires a disjoint, explicit AI-context decision for every configured publisher', () => {
    const configured = new Set(SOURCES.map((source) => source.name))
    const overlap = [...AI_CONTEXT_ALLOWED_SOURCES]
      .filter((source) => AI_CONTEXT_BLOCKED_SOURCES.has(source))
    const decided = new Set([
      ...AI_CONTEXT_ALLOWED_SOURCES,
      ...AI_CONTEXT_BLOCKED_SOURCES,
    ])

    expect(overlap).toEqual([])
    expect([...decided].sort()).toEqual([...configured].sort())
    expect(SOURCES.every((source) => sourcePolicyDecision(source.name) !== null)).toBe(true)
  })

  it('fails closed for unknown publishers', () => {
    expect(sourceAllowsAiContext('Unreviewed New Outlet')).toBe(false)
    expect(sourcePolicyDecision('Unreviewed New Outlet')).toBeNull()
  })
})
