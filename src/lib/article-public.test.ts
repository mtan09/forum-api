import { describe, expect, it } from 'vitest'
import { publicArticleFields } from './article-public'

describe('public article projection', () => {
  it('never selects the stored raw content column', () => {
    const projection = publicArticleFields('article')
    expect(projection).not.toMatch(/\barticle\.content(?:\s|,)/)
    expect(projection).toContain('article.description')
  })

  it('masks media unless the row records an approved image mode', () => {
    const projection = publicArticleFields('article')
    expect(projection).toContain("image_mode IN ('remote_no_cache', 'licensed_cache')")
  })
})
