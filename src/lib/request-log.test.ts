import { describe, expect, it } from 'vitest'
import { redactRequestLog } from './request-log'

describe('request log redaction', () => {
  it('removes search text from incoming and outgoing request logs', () => {
    expect(redactRequestLog('<-- GET /search?q=iran%20war&topic_id=123')).toBe(
      '<-- GET /search?[query-redacted]'
    )
    expect(redactRequestLog('--> GET /search?q=private+question 200 12ms')).toBe(
      '--> GET /search?[query-redacted] 200 12ms'
    )
  })

  it('leaves paths without query parameters unchanged', () => {
    expect(redactRequestLog('--> GET /health 200 2ms')).toBe('--> GET /health 200 2ms')
  })
})
