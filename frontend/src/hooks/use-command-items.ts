// Command palette item factory.
//
// Returns a stable (memoised) list of CommandItem[] built from the current
// FileList context. Items are grouped and ordered; the palette component
// applies fuzzy filtering and re-ranking on top.
//
// Groups (in display order):
//   1. Commands   — app-level actions (view, sort, new file/folder, upload, …)
//   2. Go to storage — switch between configured storages
//   3. Favorites  — pinned bookmarks (cross-session, any storage)
//   4. Recent     — MRU visits (cross-session, any storage)
//   5. On this page — current page entries (folder → navigate, file → preview)
//
// "On this page" is clearly scoped because token-pagination means filteredEntries
// only covers the currently loaded page — not the full storage.

import { useMemo } from 'react'

import { useStorages } from '@/hooks/use-storage'
import { useRecents } from '@/hooks/use-recents'
import { useFavorites } from '@/hooks/use-favorites'
import { SHORTCUTS } from '@/lib/shortcuts'
import type { SortField } from '@/lib/sort-field'
import type { SortDir } from '@/hooks/use-sort-dir'
import type { ViewMode } from '@/hooks/use-view-mode'
import type { FileEntry } from '@/types/storage'

export interface CommandItem {
  id: string
  label: string
  /// Secondary label shown on the right (hint / path / shortcut).
  hint?: string
  group: string
  /// Fuzzy-match target (defaults to `label` if omitted). Use to include
  /// alternative keywords without cluttering the displayed label.
  keywords?: string
  perform: () => void
}

// Static constants — defined at module scope to avoid recreation inside useMemo.
const SORT_FIELDS: SortField[] = ['name', 'size', 'mtime', 'type']
const SORT_LABELS: Record<SortField, string> = {
  name: 'Name',
  size: 'Size',
  mtime: 'Modified',
  type: 'Type',
}

interface Config {
  // Context
  storageName: string
  canWrite: boolean
  viewMode: ViewMode
  sortField: SortField
  sortDir: SortDir
  entries: FileEntry[]

  // Callbacks
  goToPath: (prefix: string) => void
  switchStorage: (name: string) => void
  openPreview: (entry: FileEntry) => void
  jumpTo: (storage: string, key: string, type: 'folder' | 'file') => void
  setShowNewFile: (v: boolean) => void
  setShowNewFolder: (v: boolean) => void
  setShowUpload: (v: boolean) => void
  setViewMode: (mode: ViewMode) => void
  setSortField: (field: SortField) => void
  setSortDir: (dir: SortDir) => void
  refresh: () => void
  setShowHelp: (v: boolean) => void
}

// Helper: look up the displayCombo for a shortcut id.
function displayCombo(id: string): string | undefined {
  return SHORTCUTS.find((s) => s.id === id)?.displayCombo
}

export function useCommandItems(config: Config): CommandItem[] {
  const storagesQuery = useStorages()
  const { recents } = useRecents()
  const { favorites } = useFavorites()

  // Destructure to stable primitive refs so useMemo dep array stays tight.
  const {
    storageName,
    canWrite,
    viewMode,
    sortField,
    sortDir,
    entries,
    goToPath,
    switchStorage,
    openPreview,
    jumpTo,
    setShowNewFile,
    setShowNewFolder,
    setShowUpload,
    setViewMode,
    setSortField,
    setSortDir,
    refresh,
    setShowHelp,
  } = config

  return useMemo(() => {
    const storages = storagesQuery.data?.storages ?? []
    const items: CommandItem[] = []

    // -----------------------------------------------------------------------
    // 1. Commands
    // -----------------------------------------------------------------------
    if (canWrite) {
      items.push({
        id: 'cmd-new-file',
        label: 'New file',
        group: 'Commands',
        keywords: 'create file upload write',
        perform: () => setShowNewFile(true),
      })
      items.push({
        id: 'cmd-new-folder',
        label: 'New folder',
        group: 'Commands',
        keywords: 'create directory mkdir',
        perform: () => setShowNewFolder(true),
      })
      items.push({
        id: 'cmd-upload',
        label: 'Upload files',
        group: 'Commands',
        keywords: 'upload import',
        perform: () => setShowUpload(true),
      })
    }

    const nextView: ViewMode = viewMode === 'list' ? 'grid' : 'list'
    items.push({
      id: 'cmd-toggle-view',
      label: `Switch to ${nextView} view`,
      hint: viewMode === 'list' ? 'currently list' : 'currently grid',
      group: 'Commands',
      keywords: 'view layout grid list toggle',
      perform: () => setViewMode(nextView),
    })

    items.push({
      id: 'cmd-refresh',
      label: 'Refresh listing',
      group: 'Commands',
      keywords: 'reload refresh',
      perform: refresh,
    })

    // Sort-by commands.
    SORT_FIELDS.forEach((field) => {
      if (field !== sortField) {
        items.push({
          id: `cmd-sort-${field}`,
          label: `Sort by ${SORT_LABELS[field]}`,
          group: 'Commands',
          keywords: `sort order ${field}`,
          perform: () => setSortField(field),
        })
      }
    })

    const nextDir: SortDir = sortDir === 'asc' ? 'desc' : 'asc'
    items.push({
      id: 'cmd-toggle-sort-dir',
      label: sortDir === 'asc' ? 'Sort descending' : 'Sort ascending',
      hint: `currently ${sortDir}`,
      group: 'Commands',
      keywords: 'sort direction ascending descending reverse',
      perform: () => setSortDir(nextDir),
    })

    items.push({
      id: 'cmd-help',
      label: 'Show keyboard shortcuts',
      hint: displayCombo('help'),
      group: 'Commands',
      keywords: 'help keyboard shortcuts hotkeys',
      perform: () => setShowHelp(true),
    })

    // -----------------------------------------------------------------------
    // 2. Go to storage
    // -----------------------------------------------------------------------
    for (const s of storages) {
      items.push({
        id: `storage-${s.name}`,
        label: s.name,
        hint: s.type,
        group: 'Go to storage',
        keywords: `storage ${s.name} ${s.type}`,
        perform: () => switchStorage(s.name),
      })
    }

    // -----------------------------------------------------------------------
    // 3. Favorites (cross-session, pruned to known storages)
    // -----------------------------------------------------------------------
    const knownStorageNames = new Set(storages.map((s) => s.name))
    for (const fav of favorites) {
      if (!knownStorageNames.has(fav.storage)) continue
      const isCurrentStorage = fav.storage === storageName
      items.push({
        id: `fav-${fav.storage}-${fav.key}`,
        label: fav.key || fav.storage,
        hint: isCurrentStorage ? fav.key || '(root)' : `${fav.storage}:${fav.key || ''}`,
        group: 'Favorites',
        keywords: `favorite ${fav.storage} ${fav.key}`,
        perform: () => jumpTo(fav.storage, fav.key, fav.type),
      })
    }

    // -----------------------------------------------------------------------
    // 4. Recent (cross-session, pruned to known storages)
    // -----------------------------------------------------------------------
    for (const rec of recents) {
      if (!knownStorageNames.has(rec.storage)) continue
      const isCurrentStorage = rec.storage === storageName
      items.push({
        id: `recent-${rec.storage}-${rec.key}`,
        label: rec.key || rec.storage,
        hint: isCurrentStorage ? rec.key || '(root)' : `${rec.storage}:${rec.key || ''}`,
        group: 'Recent',
        keywords: `recent ${rec.storage} ${rec.key}`,
        perform: () => jumpTo(rec.storage, rec.key, rec.type),
      })
    }

    // -----------------------------------------------------------------------
    // 5. On this page
    // -----------------------------------------------------------------------
    for (const entry of entries) {
      const name = entry.key.split('/').filter(Boolean).at(-1) ?? entry.key
      const label = entry.is_dir ? `${name}/` : name
      items.push({
        id: `entry-${entry.key}`,
        label,
        hint: entry.key,
        group: 'On this page',
        keywords: `${name} ${entry.key}`,
        perform: () => {
          if (entry.is_dir) {
            goToPath(entry.key)
          } else {
            openPreview(entry)
          }
        },
      })
    }

    return items
  }, [
    canWrite,
    viewMode,
    sortField,
    sortDir,
    storagesQuery.data,
    favorites,
    recents,
    entries,
    storageName,
    goToPath,
    switchStorage,
    openPreview,
    jumpTo,
    setShowNewFile,
    setShowNewFolder,
    setShowUpload,
    setViewMode,
    setSortField,
    setSortDir,
    refresh,
    setShowHelp,
  ])
}
