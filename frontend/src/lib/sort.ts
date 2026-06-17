import type { FileEntry } from '@/types/storage'
import type { SortDir } from '@/hooks/use-sort-dir'
import { compareEntries, type SortField } from '@/lib/sort-field'

// `numeric: true` orders "img-2.jpg" before "img-10.jpg" — natural for file
// names. `sensitivity: 'base'` makes the sort case-insensitive so adjacent
// `FOO` and `foo` group together instead of partitioning by ASCII case.
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

/// Folders are always grouped before files (file-manager convention); only
/// the alphabetical order *within* each group flips with `dir`. That keeps
/// "desc" intuitive — Z→A within folders, then Z→A within files — instead of
/// shuffling files to the top of the list when the user just wants reverse.
///
/// Name-only sort. Used by the Sidebar (folder tree) which only needs
/// alphabetical ordering and doesn't expose a field selector.
export function sortEntries(entries: FileEntry[], dir: SortDir): FileEntry[] {
  const factor = dir === 'asc' ? 1 : -1
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
    return factor * collator.compare(a.key, b.key)
  })
}

/// Multi-field sort used by the main file listing. Supports name / size /
/// mtime / type as the primary key, with name as the tiebreaker in all cases.
/// Preserves the directory-first invariant from `sortEntries`.
export function sortEntriesBy(
  entries: FileEntry[],
  field: SortField,
  dir: SortDir,
): FileEntry[] {
  return [...entries].sort((a, b) => compareEntries(a, b, field, dir))
}

export type { SortField }
