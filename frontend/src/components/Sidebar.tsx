import { useMemo } from 'react'
import { ArrowDownAZ, ArrowDownZA, ChevronUp, Folder } from 'lucide-react'

import { useListFiles } from '@/hooks/use-storage'
import { SIDEBAR_SORT_KEY, useSortDir } from '@/hooks/use-sort-dir'
import { FOLDER_COLOR } from '@/components/preview/registry'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { sortEntries } from '@/lib/sort'
import { cn } from '@/lib/utils'
import type { FileEntry } from '@/types/storage'

interface SidebarProps {
  /// Prefix to list in the sidebar. Empty string = storage root.
  parent: string
  /// Name of the directory the user is currently in — highlighted in the list.
  /// Empty when at root (nothing to highlight, and the up button is hidden).
  currentName: string
  storageName: string
  onNavigate: (prefix: string) => void
}

export function Sidebar({
  parent,
  currentName,
  storageName,
  onNavigate,
}: SidebarProps) {
  // Sidebar owns its sort axis — independent from the main view so users can
  // e.g. browse the parent dir A→Z while keeping the main panel reverse-sorted.
  const [sortDir, setSortDir] = useSortDir(SIDEBAR_SORT_KEY)
  const onToggleSort = () => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
  // The hook is keyed on (storage, prefix, token); navigating into a sibling
  // dir promotes its cached version to the main pane and the prior parent
  // listing here stays in cache for the back trip. staleTime is bumped to 5m
  // in use-storage so this is effectively zero-latency on repeat visits.
  const query = useListFiles(parent, undefined, storageName)
  const atRoot = currentName === ''

  const folders = useMemo(() => {
    const dirs = query.data?.entries.filter((e) => e.is_dir) ?? []
    return sortEntries(dirs, sortDir)
  }, [query.data?.entries, sortDir])

  return (
    <div className="flex h-full flex-col gap-1 py-2">
      <div className="mx-2 flex items-center gap-1">
        {atRoot ? (
          <div
            className="flex flex-1 items-center gap-2 truncate px-2 py-1.5 text-xs font-medium text-muted-foreground"
            title="Storage root"
          >
            <Folder className={cn('size-4 shrink-0', FOLDER_COLOR)} />
            <span className="truncate">Root</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onNavigate(parent)}
            className="flex flex-1 items-center gap-2 truncate rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
            title={parent ? `Up to ${parent}` : 'Up to root'}
          >
            <ChevronUp className="size-4 shrink-0" />
            <span className="truncate">
              {parent ? trimSlash(parent) : 'Root'}
            </span>
          </button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="size-7 shrink-0 p-0"
          aria-label={sortDir === 'asc' ? 'Sort descending' : 'Sort ascending'}
          aria-pressed={sortDir === 'desc'}
          title={
            sortDir === 'asc'
              ? 'Sort A→Z (click to flip to Z→A)'
              : 'Sort Z→A (click to flip to A→Z)'
          }
          onClick={onToggleSort}
        >
          {sortDir === 'asc' ? (
            <ArrowDownAZ className="size-4" />
          ) : (
            <ArrowDownZA className="size-4" />
          )}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        {query.isPending ? (
          <SidebarSkeleton />
        ) : folders.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            {atRoot ? 'No folders at root.' : 'No sibling folders.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {folders.map((entry) => (
              <SidebarRow
                key={entry.key}
                entry={entry}
                parent={parent}
                isCurrent={dirName(entry.key, parent) === currentName}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

interface SidebarRowProps {
  entry: FileEntry
  parent: string
  isCurrent: boolean
  onNavigate: (prefix: string) => void
}

function SidebarRow({ entry, parent, isCurrent, onNavigate }: SidebarRowProps) {
  const name = dirName(entry.key, parent)
  return (
    <li>
      <button
        type="button"
        onClick={() => onNavigate(entry.key)}
        aria-current={isCurrent ? 'true' : undefined}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
          isCurrent
            ? 'bg-muted font-medium text-foreground'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
        title={name}
      >
        <Folder className={cn('size-4 shrink-0', FOLDER_COLOR)} />
        <span className="truncate">{name}</span>
      </button>
    </li>
  )
}

function SidebarSkeleton() {
  return (
    <div className="flex flex-col gap-1.5 py-1">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-7 w-full rounded-md" />
      ))}
    </div>
  )
}

function dirName(key: string, parent: string): string {
  const rel = key.startsWith(parent) ? key.slice(parent.length) : key
  return rel.replace(/\/+$/, '')
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '') || s
}
