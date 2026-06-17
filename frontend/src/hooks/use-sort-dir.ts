import { useCallback, useState } from 'react'

import type { SortField } from '@/lib/sort-field'

export type SortDir = 'asc' | 'desc'

/// Default key kept stable so existing users' main-view preference survives
/// the split between main and sidebar sort. Callers needing a second axis
/// (e.g. the sidebar) pass their own key.
export const MAIN_SORT_KEY = 'omni-stream:sort-dir'
export const SIDEBAR_SORT_KEY = 'omni-stream:sort-dir-sidebar'
export const MAIN_SORT_FIELD_KEY = 'omni-stream:sort-field'

const SORT_FIELDS: SortField[] = ['name', 'size', 'mtime', 'type']

function readStoredDir(key: string): SortDir {
  try {
    const v = window.localStorage.getItem(key)
    if (v === 'asc' || v === 'desc') return v
  } catch {
    // localStorage may throw in privacy mode — fall through to default.
  }
  return 'asc'
}

function readStoredField(key: string): SortField {
  try {
    const v = window.localStorage.getItem(key)
    if (v && (SORT_FIELDS as string[]).includes(v)) return v as SortField
  } catch {
    // localStorage may throw in privacy mode — fall through to default.
  }
  return 'name'
}

export function useSortDir(
  storageKey: string = MAIN_SORT_KEY,
): [SortDir, (dir: SortDir) => void] {
  const [dir, setDirState] = useState<SortDir>(() => readStoredDir(storageKey))

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

/// Persisted sort field for the main file listing. The Sidebar only ever sorts
/// by name and does not use this hook. Default `'name'` preserves the
/// existing sort behaviour for all users on first load after the upgrade.
export function useSortField(
  storageKey: string = MAIN_SORT_FIELD_KEY,
): [SortField, (field: SortField) => void] {
  const [field, setFieldState] = useState<SortField>(() =>
    readStoredField(storageKey),
  )

  const setField = useCallback(
    (next: SortField) => {
      setFieldState(next)
      try {
        window.localStorage.setItem(storageKey, next)
      } catch {
        // Best-effort persistence; ignore quota / availability errors.
      }
    },
    [storageKey],
  )

  return [field, setField]
}
