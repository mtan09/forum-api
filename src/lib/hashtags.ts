// Author-selected hashtags plus any #tags typed inline; normalized to
// bare lowercase slugs, deduped, capped.
export function normalizeHashtags(provided: unknown, content: string): string[] {
  const raw: string[] = []
  if (Array.isArray(provided)) raw.push(...provided.map(String))
  raw.push(...(content.match(/#([A-Za-z0-9_]{2,30})/g) ?? []))
  const tags: string[] = []
  for (const entry of raw) {
    const tag = entry.replace(/^#/, '').toLowerCase().replace(/[^a-z0-9_]/g, '')
    if (tag.length >= 2 && tag.length <= 30 && !tags.includes(tag)) tags.push(tag)
    if (tags.length >= 8) break
  }
  return tags
}
