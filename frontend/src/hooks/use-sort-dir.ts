import { useCallback, useState } from 'react'

export type SortDir = 'asc' | 'desc'

/// Default key kept stable so existing users' main-view preference survives
/// the split between main and sidebar sort. Callers needing a second axis
/// (e.g. the sidebar) pass their own key.
export const MAIN_SORT_KEY = 'omni-stream:sort-dir'
export const SIDEBAR_SORT_KEY = 'omni-stream:sort-dir-sidebar'

function readStored(key: string): SortDir {
  try {
    const v = window.localStorage.getItem(key)
    if (v === 'asc' || v === 'desc') return v
  } catch {
    // localStorage may throw in privacy mode — fall through to default.
  }
  return 'asc'
}

export function useSortDir(
  storageKey: string = MAIN_SORT_KEY,
): [SortDir, (dir: SortDir) => void] {
  const [dir, setDirState] = useState<SortDir>(() => readStored(storageKey))

  const setDir = useCallback(
    (next: SortDir) => {
      setDirState(next)
      try {
        window.localStorage.setItem(storageKey, next)
      } catch {
        // Best-effort persistence; ignore quota / availability errors.
      }
    },
    [storageKey],
  )

  return [dir, setDir]
}
