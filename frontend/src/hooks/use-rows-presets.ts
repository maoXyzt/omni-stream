// Named rule presets persisted in localStorage. Companion to
// `useRowsViewConfig`, which keeps the active config in the URL — presets
// let users stash multiple configs without crowding the address bar.
//
// Stored shape:
//   { version: 1, presets: [{ id, name, rules, updatedAt }] }
//
// Robustness:
//   * Every stored preset re-runs through `parseRules` on read. Anything
//     that no longer validates (schema change, hand-edited storage) is
//     dropped silently rather than crashing the editor.
//   * `QuotaExceededError` from `setItem` is caught and surfaced via the
//     `error` field so the UI can tell the user to free space.
//   * A `storage` event listener keeps multiple tabs in sync.
//
// Naming policy: presets are upserted by case-insensitive name, so saving
// with an existing name overwrites instead of duplicating.

import { useCallback, useEffect, useRef, useState } from 'react'

import { type Node, parseRules } from '@/lib/rows-schema'

const STORAGE_KEY = 'omni-stream:rows-presets:v1'

export interface Preset {
  id: string
  name: string
  rules: Node[]
  updatedAt: number
}

export interface PresetsState {
  presets: Preset[]
  /// Last write error message; cleared on the next successful write.
  error: string | null
  /// Save a preset. Returns the stored preset on success, null on failure
  /// (empty name, invalid storage, quota exceeded). On failure `error` is
  /// updated with a user-facing message.
  save: (name: string, rules: Node[]) => Preset | null
  remove: (id: string) => void
}

export function useRowsPresets(): PresetsState {
  const [presets, setPresets] = useState<Preset[]>(() => readStorage())
  const [error, setError] = useState<string | null>(null)

  // Keep a ref so save/remove can compute the next array without taking
  // `presets` as a dep — that would force callers (memoized children) to
  // rerender just because the list changed.
  const presetsRef = useRef(presets)
  useEffect(() => {
    presetsRef.current = presets
  }, [presets])

  // Cross-tab sync. The `storage` event fires in *other* tabs when this
  // key changes, not the tab that wrote it — so we only need to refresh
  // from disk, not echo our own writes.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY || e.key === null) {
        setPresets(readStorage())
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const save = useCallback((rawName: string, rules: Node[]): Preset | null => {
    const name = rawName.trim()
    if (!name) {
      setError('preset name cannot be empty')
      return null
    }
    const saved: Preset = {
      id: makeId(),
      name,
      rules,
      updatedAt: Date.now(),
    }
    const next = [
      saved,
      ...presetsRef.current.filter(
        (p) => p.name.toLowerCase() !== name.toLowerCase(),
      ),
    ]
    const writeErr = writeStorage(next)
    if (writeErr) {
      setError(writeErr)
      return null
    }
    setError(null)
    setPresets(next)
    return saved
  }, [])

  const remove = useCallback((id: string) => {
    const next = presetsRef.current.filter((p) => p.id !== id)
    const writeErr = writeStorage(next)
    if (writeErr) {
      setError(writeErr)
      return
    }
    setError(null)
    setPresets(next)
  }, [])

  return { presets, error, save, remove }
}

function readStorage(): Preset[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    // Safari private mode and locked-down embeds can throw on access.
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
  const env = parsed as { version?: unknown; presets?: unknown }
  if (env.version !== 1 || !Array.isArray(env.presets)) return []
  const out: Preset[] = []
  for (const item of env.presets) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (typeof rec.id !== 'string' || rec.id.length === 0) continue
    if (typeof rec.name !== 'string' || rec.name.length === 0) continue
    if (typeof rec.updatedAt !== 'number') continue
    const result = parseRules(rec.rules)
    if (result.error) continue
    out.push({
      id: rec.id,
      name: rec.name,
      rules: result.rules,
      updatedAt: rec.updatedAt,
    })
  }
  // Newest first — matches the order saves were performed in.
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

function writeStorage(presets: Preset[]): string | null {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, presets }),
    )
    return null
  } catch (err) {
    if (
      err instanceof DOMException &&
      (err.name === 'QuotaExceededError' ||
        err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
    ) {
      return 'storage full — delete some presets to make room'
    }
    return err instanceof Error ? err.message : String(err)
  }
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
