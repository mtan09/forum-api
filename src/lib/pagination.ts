// Profile lists render unvirtualized on the client, so pages stay small. A
// single unbounded response (1000+ upvotes) locked the UI for seconds while
// every row mounted at once.
export const DEFAULT_PAGE_SIZE = 30
export const MAX_PAGE_SIZE = 50

export function parsePagination(
  limitParam: string | undefined,
  offsetParam: string | undefined,
  defaultLimit = DEFAULT_PAGE_SIZE
): { limit: number; offset: number } {
  const requested = Number(limitParam)
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), MAX_PAGE_SIZE)
    : defaultLimit
  const rawOffset = Number(offsetParam)
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0
  return { limit, offset }
}

// Endpoints that interleave two tables (posts + articles) can't paginate in
// SQL across both. Each side fetches enough rows to cover the requested page,
// then the merged list is sorted and sliced — correct because the first
// offset+limit merged items can only come from the first offset+limit of
// either side.
export function mergePage<T>(rows: T[], sortAt: (row: T) => string | Date, limit: number, offset: number): T[] {
  return rows
    .slice()
    .sort((x, y) => new Date(sortAt(y)).getTime() - new Date(sortAt(x)).getTime())
    .slice(offset, offset + limit)
}
