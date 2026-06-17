import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowDownAZ,
  ArrowDownZA,
  ChevronDown,
  ChevronRight,
  Clock,
  File,
  Folder,
  RotateCw,
  Star,
} from 'lucide-react'

import { useListFiles, useStorages } from '@/hooks/use-storage'
import { SIDEBAR_SORT_KEY, useSortDir, type SortDir } from '@/hooks/use-sort-dir'
import { useTreeExpanded, type TreeExpandedApi } from '@/hooks/use-tree-expanded'
import { useFavorites } from '@/hooks/use-favorites'
import { useRecents } from '@/hooks/use-recents'
import { EntryContextMenu } from '@/components/EntryContextMenu'
import { EntryIcon } from '@/components/EntryIcon'
import { dirVisual } from '@/components/preview/registry'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { basenameOf } from '@/lib/path'
import { sortEntries } from '@/lib/sort'
import { cn } from '@/lib/utils'
import type { FileEntry } from '@/types/storage'

interface SidebarProps {
  /// The current path the user is viewing (URL-driven). The tree highlights
  /// this folder and auto-expands its ancestors. Empty string = storage root.
  prefix: string
  storageName: string
  /// True when the active storage is S3 in multi-bucket mode. Threads
  /// through to TreeNode so depth-0 entries (which are the buckets
  /// themselves) get the bucket visual instead of the folder one.
  multiBucket: boolean
  onNavigate: (prefix: string) => void
}

export function Sidebar({
  prefix,
  storageName,
  multiBucket,
  onNavigate,
}: SidebarProps) {
  // Sidebar owns its sort axis — independent from the main view so users can
  // browse the tree A→Z while keeping the main panel reverse-sorted.
  const [sortDir, setSortDir] = useSortDir(SIDEBAR_SORT_KEY)
  const onToggleSort = () => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')

  const expand = useTreeExpanded(storageName)
  const { expandPath } = expand

  // Auto-expand every ancestor of the current path on navigation. The active
  // folder itself stays closed — highlighted, not auto-revealed.
  useEffect(() => {
    expandPath(prefix)
  }, [prefix, expandPath])

  const { favorites, remove: removeFavorite } = useFavorites()
  const { recents } = useRecents()
  const { data: storagesData } = useStorages()
  const knownStorages = useMemo(
    () => new Set(storagesData?.storages.map((s) => s.name) ?? []),
    [storagesData],
  )

  // Filter to entries whose storage still exists (prune orphans).
  const validFavorites = useMemo(
    () => favorites.filter((f) => knownStorages.has(f.storage)),
    [favorites, knownStorages],
  )
  const validRecents = useMemo(
    () => recents.filter((r) => knownStorages.has(r.storage)).slice(0, 8),
    [recents, knownStorages],
  )

  return (
    <div className="flex h-full flex-col gap-1 py-2">
      {/* Favorites section */}
      {validFavorites.length > 0 && (
        <section className="shrink-0">
          <div className="mx-2 flex items-center gap-1 px-2 py-1.5">
            <Star className="size-3.5 text-muted-foreground" />
            <span className="flex-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Favorites
            </span>
          </div>
          <ul className="px-2 pb-1">
            {validFavorites.map((f) => {
              const label = basenameOf(f.key) || f.storage
              const isActive = f.storage === storageName && (
                f.type === 'folder' ? prefix === f.key || prefix.startsWith(f.key) : false
              )
              return (
                <li key={`${f.storage}::${f.key}`}>
                  <div className="group flex items-center gap-1 rounded-sm px-2 py-1 text-xs hover:bg-accent">
                    <button
                      type="button"
                      className={cn(
                        'flex flex-1 items-center gap-1.5 truncate text-left',
                        isActive ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground',
                      )}
                      onClick={() => {
                        if (f.type === 'folder') {
                          onNavigate(f.key)
                        } else {
                          // Navigate to the file's parent directory
                          const parentKey = f.key.replace(/[^/]*$/, '')
                          onNavigate(parentKey)
                        }
                      }}
                    >
                      {f.type === 'folder' ? (
                        <Folder className="size-3.5 shrink-0" />
                      ) : (
                        <File className="size-3.5 shrink-0" />
                      )}
                      <span className="truncate">{label}</span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-5 shrink-0 opacity-0 group-hover:opacity-100"
                      aria-label={`Remove ${label} from favorites`}
                      onClick={() => removeFavorite(f.storage, f.key)}
                    >
                      <Star className="size-3 fill-current" />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
          <div className="mx-4 mb-1 h-px bg-border" />
        </section>
      )}

      {/* Recent section */}
      {validRecents.length > 0 && (
        <section className="shrink-0">
          <div className="mx-2 flex items-center gap-1 px-2 py-1.5">
            <Clock className="size-3.5 text-muted-foreground" />
            <span className="flex-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recent
            </span>
          </div>
          <ul className="px-2 pb-1">
            {validRecents.map((r) => {
              const label = basenameOf(r.key) || r.storage
              return (
                <li key={`${r.storage}::${r.key}::${r.visitedAt}`}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-1.5 truncate rounded-sm px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => {
                      if (r.type === 'folder') {
                        onNavigate(r.key)
                      } else {
                        const parentKey = r.key.replace(/[^/]*$/, '')
                        onNavigate(parentKey)
                      }
                    }}
                  >
                    {r.type === 'folder' ? (
                      <Folder className="size-3.5 shrink-0" />
                    ) : (
                      <File className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate">{label}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="mx-4 mb-1 h-px bg-border" />
        </section>
      )}

      {/* Folders tree */}
      <div className="mx-2 flex items-center gap-1 px-2 py-1.5">
        <span className="flex-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Folders
        </span>
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
        <TreeLevel
          parent=""
          depth={0}
          activePrefix={prefix}
          storageName={storageName}
          multiBucket={multiBucket}
          sortDir={sortDir}
          expand={expand}
          onNavigate={onNavigate}
        />
      </div>
    </div>
  )
}

interface TreeLevelProps {
  /// The prefix whose immediate children this level lists. `''` for root.
  parent: string
  depth: number
  activePrefix: string
  storageName: string
  multiBucket: boolean
  sortDir: SortDir
  expand: TreeExpandedApi
  onNavigate: (prefix: string) => void
  /// Fires once after the query resolves with zero directories. Lets the
  /// containing TreeNode mark itself as a known leaf (swap chevron for a
  /// spacer). Only attached for non-root levels — the root has no chevron to
  /// swap.
  onResolveEmpty?: () => void
}

function TreeLevel({
  parent,
  depth,
  activePrefix,
  storageName,
  multiBucket,
  sortDir,
  expand,
  onNavigate,
  onResolveEmpty,
}: TreeLevelProps) {
  // One query per expanded folder, cached + sorted. Pagination is not
  // consumed: directories with more than `LIST_PAGE_SIZE` children render
  // truncated in the tree (a "Load more" leaf would be the way to extend).
  const query = useListFiles(parent, undefined, storageName)

  const folders = useMemo(() => {
    const dirs = query.data?.entries.filter((e) => e.is_dir) ?? []
    return sortEntries(dirs, sortDir)
  }, [query.data?.entries, sortDir])

  const isResolvedEmpty =
    !query.isPending && !query.isError && folders.length === 0
  useEffect(() => {
    if (isResolvedEmpty && onResolveEmpty) onResolveEmpty()
  }, [isResolvedEmpty, onResolveEmpty])

  if (query.isPending) {
    return <LevelSkeleton depth={depth} />
  }

  if (query.isError) {
    return (
      <LevelError
        depth={depth}
        message={describeQueryError(query.error)}
        onRetry={() => void query.refetch()}
        isRetrying={query.isFetching}
      />
    )
  }

  if (folders.length === 0) {
    return <LevelEmpty depth={depth} atRoot={parent === ''} />
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {folders.map((entry) => (
        <TreeNode
          key={entry.key}
          entry={entry}
          depth={depth}
          activePrefix={activePrefix}
          storageName={storageName}
          multiBucket={multiBucket}
          sortDir={sortDir}
          expand={expand}
          onNavigate={onNavigate}
        />
      ))}
    </ul>
  )
}

interface TreeNodeProps {
  entry: FileEntry
  depth: number
  activePrefix: string
  storageName: string
  multiBucket: boolean
  sortDir: SortDir
  expand: TreeExpandedApi
  onNavigate: (prefix: string) => void
}

function TreeNode({
  entry,
  depth,
  activePrefix,
  storageName,
  multiBucket,
  sortDir,
  expand,
  onNavigate,
}: TreeNodeProps) {
  const name = basenameOf(entry.key)
  // depth=0 in multi-bucket S3 IS the bucket level — everything deeper is
  // a regular folder regardless of mode.
  const isBucket = multiBucket && depth === 0
  const dir = dirVisual(isBucket)
  const isCurrent = entry.key === activePrefix
  const isExpanded = expand.isExpanded(entry.key)
  const rowRef = useRef<HTMLButtonElement | null>(null)
  // Flipped once we've listed this folder and found no subdirectories, so
  // leaf folders render distinctly from "collapsed branch I haven't opened
  // yet". Session-local: a leaf that gains children server-side stays
  // visually leaf until an invalidate.
  const [knownLeaf, setKnownLeaf] = useState(false)
  const markLeaf = useCallback(() => setKnownLeaf(true), [])

  // Reveal the active row after auto-expand opens its ancestors. `nearest`
  // avoids scrolling when the row is already on screen (e.g. shallow paths).
  useEffect(() => {
    if (isCurrent) {
      rowRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [isCurrent])

  const showChildren = isExpanded && !knownLeaf

  return (
    <li>
      <EntryContextMenu entry={entry} storageName={storageName}>
        <div
          className={cn(
            'flex w-full items-center rounded-md text-sm transition-colors',
            isCurrent
              ? 'bg-muted font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )}
        >
          {knownLeaf ? (
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center"
              style={{ marginLeft: depth * 12 }}
            >
              <span className="size-1 rounded-full bg-muted-foreground/40" />
            </span>
          ) : (
            <button
              type="button"
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
              aria-expanded={isExpanded}
              onClick={(e) => {
                e.stopPropagation()
                expand.toggle(entry.key)
              }}
              className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
              style={{ marginLeft: depth * 12 }}
            >
              {isExpanded ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
            </button>
          )}
          <button
            ref={rowRef}
            type="button"
            onClick={() => {
              onNavigate(entry.key)
              // Row click acts as both navigate + expand toggle so users can
              // drill in without aiming at the small chevron. Skip on known
              // leaves — they have no children to reveal, and the toggle
              // would silently dirty the persisted expand set.
              if (!knownLeaf) expand.toggle(entry.key)
            }}
            aria-current={isCurrent ? 'page' : undefined}
            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left"
            title={name}
          >
            <EntryIcon
              Icon={dir.Icon}
              color={cn(dir.color, knownLeaf && 'opacity-60')}
              isSymlink={entry.is_symlink}
              className="size-4 shrink-0"
            />
            <span className="truncate">{name}</span>
          </button>
        </div>
      </EntryContextMenu>
      {showChildren && (
        <TreeLevel
          parent={entry.key}
          depth={depth + 1}
          activePrefix={activePrefix}
          storageName={storageName}
          multiBucket={multiBucket}
          sortDir={sortDir}
          expand={expand}
          onNavigate={onNavigate}
          onResolveEmpty={markLeaf}
        />
      )}
    </li>
  )
}

function LevelSkeleton({ depth }: { depth: number }) {
  return (
    <div className="flex flex-col gap-1 py-1">
      {Array.from({ length: depth === 0 ? 6 : 2 }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-6 rounded-md"
          style={{ marginLeft: depth * 12 + 24 }}
        />
      ))}
    </div>
  )
}

function LevelEmpty({ depth, atRoot }: { depth: number; atRoot: boolean }) {
  return (
    <p
      className="py-1 text-xs italic text-muted-foreground"
      style={{ paddingLeft: depth * 12 + 24 }}
    >
      {atRoot ? 'No folders at root.' : '(empty)'}
    </p>
  )
}

interface LevelErrorProps {
  depth: number
  message: string
  onRetry: () => void
  isRetrying: boolean
}

function LevelError({ depth, message, onRetry, isRetrying }: LevelErrorProps) {
  return (
    <div
      className="flex flex-col gap-1.5 py-1.5"
      style={{ paddingLeft: depth * 12 + 24 }}
    >
      <div className="flex items-start gap-2 text-xs text-destructive">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
        <span className="break-words">{message}</span>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        disabled={isRetrying}
        className="h-6 self-start px-2 text-xs"
      >
        <RotateCw className={cn('size-3', isRetrying && 'animate-spin')} />
        Retry
      </Button>
    </div>
  )
}

function describeQueryError(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Failed to load folders.'
}

