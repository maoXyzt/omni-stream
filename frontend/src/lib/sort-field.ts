/// Multi-field sort comparators for the file listing.
///
/// File-manager invariant preserved across all fields: **directories are
/// always grouped before files**; only the order *within* each group depends
/// on the field and direction. `null` / missing values sort last regardless of
/// direction so they don't float to the front when flipping asc ↔ desc.

import { typeLabelForEntry } from '@/components/preview/registry'
import type { SortDir } from '@/hooks/use-sort-dir'
import type { FileEntry } from '@/types/storage'

export type SortField = 'name' | 'size' | 'mtime' | 'type'

// Case-insensitive, numeric-aware collator for name / type comparisons.
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

/// Compare two `FileEntry` values by `field` and `dir`.
///
/// Returned value follows the standard comparator contract:
///   < 0 → `a` sorts first,  > 0 → `b` sorts first,  0 → equal.
export function compareEntries(
  a: FileEntry,
  b: FileEntry,
  field: SortField,
  dir: SortDir,
): number {
  // Directories always come before files — this check is field-independent.
  if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1

  const factor = dir === 'asc' ? 1 : -1

  switch (field) {
    case 'size': {
      // Directories have no meaningful size; sort within the dir group by
      // name so the ordering is stable.
      if (a.is_dir) return collator.compare(a.key, b.key)
      const diff = a.size - b.size
      // Ties in size fall back to name so the sort is deterministic.
      return diff !== 0 ? factor * diff : collator.compare(a.key, b.key)
    }

    case 'mtime': {
      const ta = parseMtime(a.last_modified)
      const tb = parseMtime(b.last_modified)
      // Null last_modified always sorts last regardless of direction so it
      // doesn't jump to the front when flipping to desc.
      if (ta === null && tb === null) return collator.compare(a.key, b.key)
      if (ta === null) return 1   // a is "no date" → sinks to bottom
      if (tb === null) return -1  // b is "no date" → b sinks
      const diff = ta - tb
      return diff !== 0 ? factor * diff : collator.compare(a.key, b.key)
    }

    case 'type': {
      const la = typeLabelForEntry(a.key, a.is_dir)
      const lb = typeLabelForEntry(b.key, b.is_dir)
      const cmp = factor * collator.compare(la, lb)
      // Within the same type, secondary sort by name keeps the list stable.
      return cmp !== 0 ? cmp : collator.compare(a.key, b.key)
    }

    case 'name':
    default:
      return factor * collator.compare(a.key, b.key)
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Parse an ISO-8601 / RFC-3339 last_modified string to a Unix epoch (ms).
/// Returns null when the string is absent or unparseable.
function parseMtime(raw: string | null): number | null {
  if (!raw) return null
  const ms = Date.parse(raw)
  return isNaN(ms) ? null : ms
}
