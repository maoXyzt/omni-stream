// Pinned bookmarks / favorites.
//
// Same robustness model as `use-recents.ts` (versioned envelope, validation,
// QuotaExceeded, cross-tab sync).
//
// Stored shape:
//   { version: 1, favorites: [{ storage, key, type, pinnedAt }] }
//
// Naming policy: (storage, key) pairs are unique — calling `add` on an
// already-favorited entry is a no-op (does not update `pinnedAt`).

import { useCallback, useEffect, useState } from 'react'

import type {
  StorageEntryRef,
  StorageEntryType,
} from '@/types/storage'

const STORAGE_KEY = 'omni-stream:favorites:v1'

export type FavoriteType = StorageEntryType

export interface FavoriteEntry extends StorageEntryRef {
  pinnedAt: number
}

export interface FavoritesState {
  favorites: FavoriteEntry[]
  add: (storage: string, key: string, type: FavoriteType) => void
  remove: (storage: string, key: string) => void
}

export function useFavorites(): FavoritesState {
  const [favorites, setFavorites] = useState<FavoriteEntry[]>(() => readStorage())

  // Cross-tab sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY || e.key === null) {
        setFavorites(readStorage())
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const add = useCallback((storage: string, key: string, type: FavoriteType) => {
    // Re-read storage on every mutation to avoid overwriting concurrent writes
    // from other tabs that arrived between the last storage event and now.
    const current = readStorage()
    if (current.some((f) => f.storage === storage && f.key === key)) return
    const updated = [...current, { storage, key, type, pinnedAt: Date.now() }]
    const err = writeStorage(updated)
    if (!err) setFavorites(updated)
  }, [])

  const remove = useCallback((storage: string, key: string) => {
    const current = readStorage()
    const updated = current.filter(
      (f) => !(f.storage === storage && f.key === key),
    )
    const err = writeStorage(updated)
    if (!err) setFavorites(updated)
  }, [])

  return { favorites, add, remove }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function readStorage(): FavoriteEntry[] {
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
  const env = parsed as { version?: unknown; favorites?: unknown }
  if (env.version !== 1 || !Array.isArray(env.favorites)) return []
  const out: FavoriteEntry[] = []
  for (const item of env.favorites) {
    if (!item || typeof item !== 'object') continue
    const f = item as Record<string, unknown>
    if (typeof f.storage !== 'string' || f.storage.length === 0) continue
    if (typeof f.key !== 'string') continue
    if (f.type !== 'folder' && f.type !== 'file') continue
    if (typeof f.pinnedAt !== 'number') continue
    out.push({
      storage: f.storage,
      key: f.key,
      type: f.type,
      pinnedAt: f.pinnedAt,
    })
  }
  return out
}

function writeStorage(favorites: FavoriteEntry[]): string | null {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, favorites }))
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
