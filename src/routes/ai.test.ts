import { describe, expect, it } from 'vitest'
import { buildForumAiSystemPrompt, historyToMessages, splitSections } from './ai'

describe('forumAI perspective generation contract', () => {
  it('asks the model to establish center before contrasting left and right', () => {
    const prompt = buildForumAiSystemPrompt('General Audience', null, '')

    expect(prompt.indexOf('===CENTER===')).toBeLessThan(prompt.indexOf('===LEFT==='))
    expect(prompt.indexOf('===LEFT===')).toBeLessThan(prompt.indexOf('===RIGHT==='))
    expect(prompt).toContain('do not merely paraphrase one conclusion three times')
    expect(prompt).toContain('core diagnosis, highest priority, preferred action')
    expect(prompt).toContain('Center is not an arithmetic midpoint')
  })

  it('replays assistant history in the same center-first generation order', () => {
    const messages = historyToMessages([
      { role: 'assistant', center: 'center answer', left: 'left answer', right: 'right answer' },
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe(
      '===CENTER===\ncenter answer\n===LEFT===\nleft answer\n===RIGHT===\nright answer'
    )
  })

  it('parses center-first output into the existing client response fields', () => {
    expect(
      splitSections(
        '===CENTER===\ncenter answer\n===LEFT===\nleft answer\n===RIGHT===\nright answer'
      )
    ).toEqual({
      left: 'left answer\n',
      center: 'center answer\n',
      right: 'right answer',
    })
  })
})
