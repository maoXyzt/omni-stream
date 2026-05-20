import { useCallback, useState } from 'react'

/// How the grid view's image thumbnails fill their tile:
///   * `cover` — fill the tile, crop overflow. Best for visually uniform
///     grids; the default for most file browsers.
///   * `contain` — show the entire image with letterboxing. Useful when
///     the user cares about composition / aspect ratio and doesn't want
///     any portion of the image hidden.
export type GridFit = 'cover' | 'contain'

const STORAGE_KEY = 'omni-stream:grid-fit'

function readStored(): GridFit {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    if (v === 'cover' || v === 'contain') return v
  } catch {
    // localStorage may throw in privacy mode / sandboxed iframes — fall through.
  }
  return 'cover'
}

export function useGridFit(): [GridFit, (fit: GridFit) => void] {
  const [fit, setFitState] = useState<GridFit>(readStored)

  const setFit = useCallback((next: GridFit) => {
    setFitState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Persistence is best-effort; ignore quota / availability errors.
    }
  }, [])

  return [fit, setFit]
}
