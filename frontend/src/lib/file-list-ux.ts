export type FileListEmptyState = 'empty-directory' | 'no-matches' | null

export function getDirectoryScrollTop(
  isHistoryNavigation: boolean,
  savedScrollTop?: number,
): number {
  return isHistoryNavigation ? (savedScrollTop ?? 0) : 0
}

export function getFileListEmptyState(
  totalCount: number,
  visibleCount: number,
): FileListEmptyState {
  if (visibleCount > 0) return null
  return totalCount === 0 ? 'empty-directory' : 'no-matches'
}
