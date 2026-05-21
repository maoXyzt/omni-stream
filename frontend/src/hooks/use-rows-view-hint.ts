import { useCallback, useState } from 'react'

// One-time onboarding flag for the "Browse as cards" hint shown atop the
// previews of rows-view-eligible formats (parquet / csv / jsonl / json).
// Stored globally — once a user dismisses the hint or clicks through to
// the cards view, it stays gone across files and storages.
const STORAGE_KEY = 'omni-stream:rows-view-hint-dismissed'

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function useRowsViewHint(): {
  dismissed: boolean
  dismiss: () => void
} {
  const [dismissed, setDismissed] = useState<boolean>(readStored)

  const dismiss = useCallback(() => {
    setDismissed(true)
    try {
      window.localStorage.setItem(STORAGE_KEY, '1')
    } catch {
      // Persistence is best-effort; the hint will reappear next session
      // if writing fails. Not worth surfacing to the user.
    }
  }, [])

  return { dismissed, dismiss }
}
