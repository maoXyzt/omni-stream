import { useCallback, useState } from 'react'

export type SortDir = 'asc' | 'desc'

const STORAGE_KEY = 'omni-stream:sort-dir'

function readStored(): SortDir {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    if (v === 'asc' || v === 'desc') return v
  } catch {
    // localStorage may throw in privacy mode — fall through to default.
  }
  return 'asc'
}

export function useSortDir(): [SortDir, (dir: SortDir) => void] {
  const [dir, setDirState] = useState<SortDir>(readStored)

  const setDir = useCallback((next: SortDir) => {
    setDirState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Best-effort persistence; ignore quota / availability errors.
    }
  }, [])

  return [dir, setDir]
}
