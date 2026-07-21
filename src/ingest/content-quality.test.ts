import { describe, expect, it } from 'vitest'
import { looksLikeVideoPlaylistChrome } from './content-quality'

describe('looksLikeVideoPlaylistChrome', () => {
  it('detects timestamp-heavy video navigation from any publisher', () => {
    const text =
      '02:09 Now Playing Main video 03:22 UP NEXT Unrelated topic 00:21 Another headline'
    expect(looksLikeVideoPlaylistChrome(text)).toBe(true)
  })

  it('does not reject normal prose containing a clock time', () => {
    const text = 'The hearing began at 10:30 and ended after lawmakers completed their questions.'
    expect(looksLikeVideoPlaylistChrome(text)).toBe(false)
  })

  it('does not reject a normal article that mentions embedded video controls', () => {
    const text = 'The page displayed an Up Next label after the 01:30 clip, according to the report.'
    expect(looksLikeVideoPlaylistChrome(text)).toBe(false)
  })
})
