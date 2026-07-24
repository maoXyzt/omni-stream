export type FileListEmptyState = 'empty-directory' | 'no-matches' | null

const MAX_SCROLL_POSITIONS = 50
// 420px preview content + 12px pane gutter + 4px resize handle.
export const INLINE_PREVIEW_RESERVED_WIDTH = 436

interface BrowseScrollTransition {
  pageChanged: boolean
  splitViewChanged: boolean
  historyNavigation: boolean
  savedScrollTop?: number
  previousScrollTop?: number
}

export function getBrowseScrollTarget({
  pageChanged,
  splitViewChanged,
  historyNavigation,
  savedScrollTop,
  previousScrollTop,
}: BrowseScrollTransition): number | null {
  if (pageChanged) return historyNavigation ? (savedScrollTop ?? 0) : 0
  if (!splitViewChanged) return null
  return historyNavigation ? (savedScrollTop ?? 0) : (previousScrollTop ?? 0)
}

export function saveScrollPosition(
  positions: Map<string, number>,
  key: string,
  scrollTop: number,
): void {
  positions.delete(key)
  positions.set(key, scrollTop)
  if (positions.size <= MAX_SCROLL_POSITIONS) return
  const oldestKey = positions.keys().next().value
  if (oldestKey !== undefined) positions.delete(oldestKey)
}

export function getFileListEmptyState(
  totalCount: number,
  visibleCount: number,
): FileListEmptyState {
  if (visibleCount > 0) return null
  return totalCount === 0 ? 'empty-directory' : 'no-matches'
}

export function canShowInlinePreview(
  contentWidth: number | null,
  listWidth: number,
): boolean {
  return (
    contentWidth !== null &&
    contentWidth >= listWidth + INLINE_PREVIEW_RESERVED_WIDTH
  )
}
