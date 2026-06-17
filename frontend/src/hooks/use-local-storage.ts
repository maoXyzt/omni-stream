// Generic localStorage hook with versioned envelope, read-time validation,
// QuotaExceededError handling, and cross-tab `storage` event sync.
//
// Distilled from `use-rows-presets.ts` — same robustness patterns:
//   * Read through a user-supplied validator on every load (schema evolution
//     or hand-edited storage silently drops invalid values back to default).
//   * `QuotaExceededError` is caught and surfaced via the returned `error`.
//   * The `storage` event fires only in *other* tabs, so we refresh from disk
//     there without echoing our own writes.
//   * Write callbacks keep a `ref` to the latest value so they don't take it
//     as a dependency and force consumers (often memoized children) to
//     re-render unnecessarily.
//
// Stored shape:  { version: <VERSION>, value: T }

import { useCallback, useEffect, useRef, useState } from 'react'

export interface LocalStorageState<T> {
  value: T
  /// Non-null when the last write failed (quota exceeded or serialisation
  /// error). Cleared on the next successful write.
  error: string | null
  set: (next: T) => void
}

interface Options<T> {
  /// The localStorage key, e.g. `'omni-stream:favorites:v1'`.
  key: string
  /// Schema version written into the stored envelope. Bump when the shape of
  /// T changes in an incompatible way — old data is treated as absent.
  version: number
  /// Default value when the key is absent or the stored data is invalid.
  defaultValue: T
  /// Validate and coerce the raw parsed value. Return `null` to reject
  /// (triggers a fallback to `defaultValue`). Use this to handle schema
  /// migration or to strip fields that no longer exist.
  validate: (raw: unknown) => T | null
}

export function useLocalStorage<T>({
  key,
  version,
  defaultValue,
  validate,
}: Options<T>): LocalStorageState<T> {
  const [value, setValue] = useState<T>(() =>
    readStorage(key, version, defaultValue, validate),
  )
  const [error, setError] = useState<string | null>(null)

  // Ref so `set` doesn't need `value` in its dep array.
  const valueRef = useRef(value)
  useEffect(() => {
    valueRef.current = value
  }, [value])

  // Cross-tab sync: the `storage` event fires in OTHER tabs when this key
  // changes or when `clear()` is called (e.key === null).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === key || e.key === null) {
        setValue(readStorage(key, version, defaultValue, validate))
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [key, version, defaultValue, validate])

  const set = useCallback(
    (next: T) => {
      const err = writeStorage(key, version, next)
      if (err) {
        setError(err)
        return
      }
      setError(null)
      setValue(next)
    },
    [key, version],
  )

  return { value, error, set }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readStorage<T>(
  key: string,
  version: number,
  defaultValue: T,
  validate: (raw: unknown) => T | null,
): T {
  let raw: string | null
  try {
    raw = localStorage.getItem(key)
  } catch {
    // Safari private mode and locked-down embeds may throw on access.
    return defaultValue
  }
  if (!raw) return defaultValue
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return defaultValue
  }
  if (!parsed || typeof parsed !== 'object') return defaultValue
  const env = parsed as { version?: unknown; value?: unknown }
  if (env.version !== version) return defaultValue
  const result = validate(env.value)
  return result !== null ? result : defaultValue
}

function writeStorage<T>(
  key: string,
  version: number,
  value: T,
): string | null {
  try {
    localStorage.setItem(key, JSON.stringify({ version, value }))
    return null
  } catch (err) {
    if (
      err instanceof DOMException &&
      (err.name === 'QuotaExceededError' ||
        err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
    ) {
      return 'localStorage full — clear some data to free space'
    }
    return err instanceof Error ? err.message : String(err)
  }
}
