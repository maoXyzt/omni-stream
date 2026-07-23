import { useCallback, useEffect, useRef, useState } from 'react'

const KEY_PREFIX = 'omni-stream:tree-expanded:'

/// Per-storage cap on persisted expanded prefixes. JS `Set` preserves
/// insertion order, so adding a new prefix at the end + dropping from the
/// front gives us a cheap LRU (most-recently-expanded wins). Tuning rationale:
/// ~500 entries × ~50B average ≈ 25KB per storage — generous for even heavy
/// users while leaving the localStorage budget intact across many storages.
const EXPANDED_CAP = 500

function storageKey(storageName: string): string {
  return `${KEY_PREFIX}${storageName}`
}

function readStored(storageName: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(storageKey(storageName))
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is string => typeof v === 'string'))
  } catch {
    return new Set()
  }
}

/// Returns true on success. False signals the caller should shrink the
/// in-memory state and retry on the next render — we shed half by default to
/// guarantee termination even when other apps are pressuring the same origin's
/// localStorage budget.
function writeStored(storageName: string, expanded: Set<string>): boolean {
  try {
    window.localStorage.setItem(
      storageKey(storageName),
      JSON.stringify([...expanded]),
    )
    return true
  } catch (err) {
    if (isQuotaError(err)) return false
    // Privacy-mode / disabled storage etc. — persistence is best-effort.
    return true
  }
}

function isQuotaError(err: unknown): boolean {
  if (!(err instanceof DOMException)) return false
  // Cross-browser: Chrome/Edge use the named constant; Firefox historically
  // used `NS_ERROR_DOM_QUOTA_REACHED`; code 22 is the legacy numeric value.
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22
  )
}

/// Drop oldest entries (front of insertion order) when over the cap.
function capSet(set: Set<string>): Set<string> {
  if (set.size <= EXPANDED_CAP) return set
  const arr = [...set]
  return new Set(arr.slice(arr.length - EXPANDED_CAP))
}

/// Remove `tree-expanded` entries for storages that no longer exist in the
/// server's roster. Called from App once the storages list resolves — guards
/// against unbounded growth from renamed / removed storages over time.
export function pruneOrphanTreeExpanded(validStorageNames: string[]): void {
  try {
    const valid = new Set(validStorageNames.map((n) => storageKey(n)))
    const toRemove: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (key && key.startsWith(KEY_PREFIX) && !valid.has(key)) {
        toRemove.push(key)
      }
    }
    for (const key of toRemove) {
      window.localStorage.removeItem(key)
    }
  } catch {
    // Best-effort cleanup; never block app boot on localStorage failures.
  }
}

/// Tree-node expansion set, persisted per-storage in localStorage. Each entry
/// is a directory prefix ending in `/` (e.g. `videos/2024/`). Empty prefix
/// (`''`) is implicitly always expanded (the tree root) and not tracked.
export interface TreeExpandedApi {
  isExpanded: (prefix: string) => boolean
  toggle: (prefix: string) => void
  open: (prefix: string) => void
  /// Add every *ancestor* of `prefix` to the expanded set. The prefix itself
  /// is NOT added — the active folder is highlighted, not auto-opened, so
  /// users still drive whether to reveal its children.
  expandPath: (prefix: string) => void
}

export function useTreeExpanded(storageName: string): TreeExpandedApi {
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    readStored(storageName),
  )

  // Reload from the new storage's key when the active storage changes. A ref
  // tracks the last-seen name so the initial render doesn't re-read (it
  // already used the same name via the lazy initializer above).
  const lastStorageRef = useRef(storageName)
  useEffect(() => {
    if (lastStorageRef.current === storageName) return
    lastStorageRef.current = storageName
    setExpanded(readStored(storageName))
  }, [storageName])

  useEffect(() => {
    const ok = writeStored(storageName, expanded)
    if (!ok) {
      // Quota hit — drop oldest half and let the next render retry. Halving
      // (rather than a fixed trim) guarantees termination even if the budget
      // shrinks further between attempts.
      setExpanded((prev) => {
        if (prev.size <= 1) return prev
        const arr = [...prev]
        return new Set(arr.slice(Math.ceil(arr.length / 2)))
      })
    }
  }, [storageName, expanded])

  const isExpanded = useCallback(
    (prefix: string) => expanded.has(prefix),
    [expanded],
  )

  const toggle = useCallback((prefix: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(prefix)) {
        next.delete(prefix)
      } else {
        // Touch: delete-then-add keeps insertion order honest as LRU recency.
        next.add(prefix)
      }
      return capSet(next)
    })
  }, [])

  const open = useCallback((prefix: string) => {
    setExpanded((prev) => {
      if (prev.has(prefix)) return prev
      const next = new Set(prev)
      next.add(prefix)
      return capSet(next)
    })
  }, [])

  const expandPath = useCallback((prefix: string) => {
    if (!prefix) return
    const segments = prefix.replace(/\/+$/, '').split('/').filter(Boolean)
    if (segments.length === 0) return
    setExpanded((prev) => {
      const next = new Set(prev)
      let acc = ''
      // Add every strict ancestor — stop one short of the full prefix so the
      // active folder itself isn't auto-expanded. Touch existing entries
      // (delete-then-add) so navigation refreshes their LRU recency.
      for (let i = 0; i < segments.length - 1; i++) {
        acc += `${segments[i]}/`
        if (next.has(acc)) next.delete(acc)
        next.add(acc)
      }
      // No-op when the membership and ordering both match — avoid a wasted
      // render + write when nothing actually changed.
      if (next.size === prev.size && sameOrder(prev, next)) return prev
      return capSet(next)
    })
  }, [])

  return { isExpanded, toggle, open, expandPath }
}

function sameOrder(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  const ai = a.values()
  const bi = b.values()
  for (let i = 0; i < a.size; i++) {
    if (ai.next().value !== bi.next().value) return false
  }
  return true
}
