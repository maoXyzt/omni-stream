import { useCallback, useState } from 'react'

export type ViewMode = 'list' | 'grid'

const STORAGE_KEY = 'omni-stream:view-mode'

function readStored(): ViewMode {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    if (v === 'list' || v === 'grid') return v
    // Legacy: 'gallery' used to be its own mode. It's now folded into list
    // (list automatically splits when a preview is open on desktop).
    if (v === 'gallery') return 'list'
  } catch {
    // localStorage may throw in privacy mode / sandboxed iframes — fall through.
  }
  return 'list'
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
