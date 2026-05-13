import { useCallback, useState } from 'react'

const STORAGE_KEY = 'omni-stream:sidebar-collapsed'

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function useSidebarCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsedState] = useState<boolean>(readStored)

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
    } catch {
      // Persistence is best-effort; ignore quota / availability errors.
    }
  }, [])

  return [collapsed, setCollapsed]
}
