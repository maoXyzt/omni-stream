import { useCallback, useState } from 'react'

export type ViewMode = 'list' | 'grid' | 'gallery'

const STORAGE_KEY = 'omni-stream:view-mode'

function readStored(): ViewMode {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    if (v === 'list' || v === 'grid' || v === 'gallery') return v
  } catch {
    // localStorage may throw in privacy mode / sandboxed iframes — fall through.
  }
  return 'gallery'
}

export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setModeState] = useState<ViewMode>(readStored)

  const setMode = useCallback((next: ViewMode) => {
    setModeState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Persistence is best-effort; ignore quota / availability errors.
    }
  }, [])

  return [mode, setMode]
}
