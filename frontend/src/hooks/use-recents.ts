// Recently-visited locations (storage + prefix or file key).
//
// Modelled directly on `use-rows-presets.ts`: versioned envelope, read-time
// validation, QuotaExceededError handling, cross-tab `storage` event sync,
// ref-based writes to avoid forcing re-renders on memoized consumers.
//
// Stored shape:
//   { version: 1, recents: [{ storage, key, type, visitedAt }] }
//
// Policy:
//   * Capped at MAX_RECENTS entries (MRU — newest first).
//   * Each (storage, key) pair is unique; re-visiting moves the entry to the top.
//   * On read, entries whose storage no longer exists in the server roster are
//     left in the list (pruning requires knowing the roster, handled at the
//     call site by filtering with useStorages before rendering).

import { useCallback, useEffect, useState } from 'react'

import type {
  StorageEntryRef,
  StorageEntryType,
} from '@/types/storage'

const STORAGE_KEY = 'omni-stream:recents:v1'
const MAX_RECENTS = 30

export type RecentType = StorageEntryType

export interface RecentEntry extends StorageEntryRef {
  visitedAt: number
}

export interface RecentsState {
  recents: RecentEntry[]
  /// Record a visit. Upserts by (storage, key); moves existing entry to top.
  record: (storage: string, key: string, type: RecentType) => void
  remove: (storage: string, key: string) => void
  clear: () => void
}

export function useRecents(): RecentsState {
  const [recents, setRecents] = useState<RecentEntry[]>(() => readStorage())

  // Cross-tab sync — the `storage` event fires in OTHER tabs.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY || e.key === null) {
        setRecents(readStorage())
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const record = useCallback((storage: string, key: string, type: RecentType) => {
    // Re-read storage on every mutation to avoid losing concurrent writes from
    // other tabs that arrived between the last storage event and now.
    const current = readStorage()
    const next: RecentEntry = { storage, key, type, visitedAt: Date.now() }
    const filtered = current.filter(
      (r) => !(r.storage === storage && r.key === key),
    )
    const updated = [next, ...filtered].slice(0, MAX_RECENTS)
    const err = writeStorage(updated)
    if (!err) setRecents(updated)
  }, [])

  const remove = useCallback((storage: string, key: string) => {
    const current = readStorage()
    const updated = current.filter(
      (r) => !(r.storage === storage && r.key === key),
    )
    const err = writeStorage(updated)
    if (!err) setRecents(updated)
  }, [])

  const clear = useCallback(() => {
    const err = writeStorage([])
    if (!err) setRecents([])
  }, [])

  return { recents, record, remove, clear }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function readStorage(): RecentEntry[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return []
  }
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const env = parsed as { version?: unknown; recents?: unknown }
  if (env.version !== 1 || !Array.isArray(env.recents)) return []
  const out: RecentEntry[] = []
  for (const item of env.recents) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r.storage !== 'string' || r.storage.length === 0) continue
    if (typeof r.key !== 'string') continue
    if (r.type !== 'folder' && r.type !== 'file') continue
    if (typeof r.visitedAt !== 'number') continue
    out.push({
      storage: r.storage,
      key: r.key,
      type: r.type,
      visitedAt: r.visitedAt,
    })
  }
  return out
}

function writeStorage(recents: RecentEntry[]): string | null {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, recents }))
    return null
  } catch (err) {
    if (
      err instanceof DOMException &&
      (err.name === 'QuotaExceededError' ||
        err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
    ) {
      return 'localStorage full'
    }
    return err instanceof Error ? err.message : String(err)
  }
}
