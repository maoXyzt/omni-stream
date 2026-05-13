import { useCallback, useState } from 'react'

const STORAGE_KEY = 'omni-stream:line-numbers'

// Default-on matches the convention of every code editor; users who don't
// want them have to opt out once and the choice sticks via localStorage.
const DEFAULT = true

function readStored(): boolean {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    if (v === 'true') return true
    if (v === 'false') return false
  } catch {
    // localStorage may throw in privacy mode / sandboxed iframes — fall through.
  }
  return DEFAULT
}

export function useLineNumbers(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabledState] = useState<boolean>(readStored)

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next))
    } catch {
      // Persistence is best-effort; ignore quota / availability errors.
    }
  }, [])

  return [enabled, setEnabled]
}
