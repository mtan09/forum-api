import { describe, expect, it } from 'vitest'
import { publicArticleFields } from './article-public'

describe('public article projection', () => {
  it('never selects the stored raw content column', () => {
    const projection = publicArticleFields('article')
    expect(projection).not.toMatch(/\barticle\.content(?:\s|,)/)
    expect(projection).toContain('article.description')
  })

  it('supports managed thumbnails and remote fallback without exposing disabled media', () => {
    const projection = publicArticleFields('article')
    expect(projection).toContain("image_mode = 'managed_thumbnail'")
    expect(projection).toContain("image_mode IN ('remote_no_cache', 'licensed_cache')")
    expect(projection).toContain('article.media_thumbnail_url')
  })
})
