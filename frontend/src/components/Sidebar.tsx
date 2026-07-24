import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import {
  AlertCircle,
  ArrowDownAZ,
  ArrowDownZA,
  ChevronDown,
  ChevronRight,
  ChevronsUp,
  Clock,
  File,
  Folder,
  Loader2,
  RotateCw,
  Star,
} from 'lucide-react'

import { useInfiniteListFiles, useStorages } from '@/hooks/use-storage'
import { SIDEBAR_SORT_KEY, useSortDir, type SortDir } from '@/hooks/use-sort-dir'
import { useTreeExpanded, type TreeExpandedApi } from '@/hooks/use-tree-expanded'
import { useFavorites } from '@/hooks/use-favorites'
import { useRecents } from '@/hooks/use-recents'
import { EntryContextMenu } from '@/components/EntryContextMenu'
import { EntryIcon } from '@/components/EntryIcon'
import { dirVisual } from '@/components/preview/registry'
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { basenameOf } from '@/lib/path'
import { sortEntries } from '@/lib/sort'
import {
  getTreeKeyboardAction,
  reconcileTreeFocus,
} from '@/lib/tree-navigation'
import { getSidebarEntryPresentation } from '@/lib/sidebar-navigation'
import { cn } from '@/lib/utils'
import type { FileEntry, StorageEntryRef } from '@/types/storage'

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
  onNavigateEntry: (entry: StorageEntryRef) => void
}

export function Sidebar({
  prefix,
  storageName,
  multiBucket,
  onNavigate,
  onNavigateEntry,
}: SidebarProps) {
  // Sidebar owns its sort axis — independent from the main view so users can
  // browse the tree A→Z while keeping the main panel reverse-sorted.
  const [sortDir, setSortDir] = useSortDir(SIDEBAR_SORT_KEY)
  const onToggleSort = () => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')

  const expand = useTreeExpanded(storageName)
  const { expandPath } = expand
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)

  // Auto-expand every ancestor of the current path on navigation. The active
  // folder itself stays closed — highlighted, not auto-revealed.
  useEffect(() => {
    expandPath(prefix)
  }, [prefix, expandPath])

  useEffect(() => {
    setFocusedKey(null)
  }, [storageName])

  const { favorites, remove: removeFavorite } = useFavorites()
  const { recents } = useRecents()
  const storagesQuery = useStorages()
  const knownStorages = useMemo(
    () => new Set(storagesQuery.data?.storages.map((s) => s.name) ?? []),
    [storagesQuery.data],
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

  function handleTreeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const tree = treeRef.current
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
      '[data-tree-key]',
    )
    if (!tree || !target || !tree.contains(target)) return

    const elements = Array.from(
      tree.querySelectorAll<HTMLButtonElement>('[data-tree-key]'),
    )
    const index = elements.indexOf(target)
    const action = getTreeKeyboardAction(
      event.key,
      elements.map((element) => ({
        depth: Number(element.dataset.treeDepth),
        expanded:
          element.getAttribute('aria-expanded') === null
            ? null
            : element.getAttribute('aria-expanded') === 'true',
      })),
      index,
    )
    if (!action) return

    event.preventDefault()
    if (action.type === 'focus') {
      const next = elements[action.index]
      if (!next) return
      setFocusedKey(next.dataset.treeKey ?? null)
      next.focus()
      return
    }

    setFocusedKey(target.dataset.treeKey ?? null)
    target
      .closest('[data-tree-row]')
      ?.querySelector<HTMLButtonElement>('[data-tree-toggle]')
      ?.click()
  }

  return (
    <Tabs
      defaultValue="folders"
      className="flex h-full min-h-0 flex-col gap-1 py-2"
    >
      <TabsList
        className="mx-2 grid w-auto shrink-0 grid-cols-2 pointer-coarse:h-11"
        aria-label="Sidebar views"
      >
        <TabsTrigger value="folders">Folders</TabsTrigger>
        <TabsTrigger value="quick-access">Quick access</TabsTrigger>
      </TabsList>

      <TabsContent
        value="folders"
        forceMount
        className="min-h-0 flex-1 data-[state=inactive]:hidden"
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="mx-2 flex items-center gap-1 px-2 py-1.5">
            <span className="flex-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Folders
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 shrink-0 p-0 pointer-coarse:size-11"
                  aria-label="Collapse tree to current folder"
                  onClick={() => {
                    expand.collapseToPath(prefix)
                    setFocusedKey(prefix || null)
                  }}
                >
                  <ChevronsUp className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Collapse other folders</TooltipContent>
            </Tooltip>
            <Button
              variant="ghost"
              size="sm"
              className="size-7 shrink-0 p-0 pointer-coarse:size-11"
              aria-label={
                sortDir === 'asc' ? 'Sort descending' : 'Sort ascending'
              }
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

          <div
            ref={treeRef}
            role="tree"
            aria-label="Folders"
            onKeyDown={handleTreeKeyDown}
            className="min-h-24 flex-1 overflow-y-auto px-2"
          >
            <TreeLevel
              parent=""
              depth={0}
              activePrefix={prefix}
              storageName={storageName}
              multiBucket={multiBucket}
              sortDir={sortDir}
              expand={expand}
              onNavigate={onNavigate}
              focusedKey={focusedKey}
              onFocusKey={setFocusedKey}
            />
          </div>
        </div>
      </TabsContent>

      <TabsContent
        value="quick-access"
        forceMount
        className="min-h-0 flex-1 overflow-y-auto px-2 data-[state=inactive]:hidden"
      >
        {storagesQuery.isPending ? (
          <QuickAccessSkeleton />
        ) : storagesQuery.isError && storagesQuery.data === undefined ? (
          <Alert variant="destructive" className="my-2">
            <AlertCircle />
            <AlertTitle>Failed to load quick access</AlertTitle>
            <AlertDescription>
              <p>
                {storagesQuery.error instanceof Error
                  ? storagesQuery.error.message
                  : 'Failed to load storages.'}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2 h-7 px-2 text-xs pointer-coarse:min-h-11"
                disabled={storagesQuery.isFetching}
                onClick={() => void storagesQuery.refetch()}
              >
                {storagesQuery.isFetching ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RotateCw className="size-4" />
                )}
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {storagesQuery.isFetching && (
              <p
                role="status"
                className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground"
              >
                <Loader2 className="size-4 animate-spin" />
                Refreshing quick access…
              </p>
            )}

            {validFavorites.length === 0 && validRecents.length === 0 ? (
              <div className="px-2 py-8 text-center text-xs text-muted-foreground">
                <p>No quick access items yet.</p>
                <p className="mt-1">
                  Star an item or open a location to add it here.
                </p>
              </div>
            ) : (
              <>
                {validFavorites.length > 0 && (
                  <section>
                    <div className="flex items-center gap-1 px-2 py-1.5">
                      <Star className="size-3.5 text-muted-foreground" />
                      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Favorites
                      </h2>
                    </div>
                    <ul className="pb-1">
                      {validFavorites.map((f) => {
                        const presentation = getSidebarEntryPresentation(
                          f,
                          storageName,
                          prefix,
                        )
                        return (
                          <li key={`${f.storage}::${f.key}`}>
                            <div
                              className={cn(
                                'group flex items-center gap-1 rounded-sm px-2 py-1 text-xs hover:bg-accent',
                                presentation.isActive && 'bg-accent/60',
                              )}
                            >
                              <button
                                type="button"
                                className={cn(
                                  'flex min-w-0 flex-1 items-center gap-1.5 text-left pointer-coarse:min-h-11',
                                  presentation.isActive
                                    ? 'font-medium text-foreground'
                                    : 'text-muted-foreground hover:text-foreground',
                                )}
                                aria-label={`Open ${presentation.label}, ${presentation.location}`}
                                aria-current={
                                  presentation.isCurrent ? 'page' : undefined
                                }
                                onClick={() => onNavigateEntry(f)}
                              >
                                {f.type === 'folder' ? (
                                  <Folder className="size-3.5 shrink-0" />
                                ) : (
                                  <File className="size-3.5 shrink-0" />
                                )}
                                <span className="flex min-w-0 flex-col">
                                  <span className="truncate">
                                    {presentation.label}
                                  </span>
                                  <span className="truncate text-xs font-normal text-muted-foreground">
                                    {presentation.location}
                                  </span>
                                </span>
                              </button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="size-5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100"
                                aria-label={`Remove ${presentation.label} from favorites`}
                                onClick={() =>
                                  removeFavorite(f.storage, f.key)
                                }
                              >
                                <Star className="size-3 fill-current" />
                              </Button>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </section>
                )}

                {validFavorites.length > 0 && validRecents.length > 0 && (
                  <div className="mx-2 my-1 h-px bg-border" />
                )}

                {validRecents.length > 0 && (
                  <section>
                    <div className="flex items-center gap-1 px-2 py-1.5">
                      <Clock className="size-3.5 text-muted-foreground" />
                      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Recent
                      </h2>
                    </div>
                    <ul className="pb-1">
                      {validRecents.map((r) => {
                        const presentation = getSidebarEntryPresentation(
                          r,
                          storageName,
                          prefix,
                        )
                        return (
                          <li key={`${r.storage}::${r.key}::${r.visitedAt}`}>
                            <button
                              type="button"
                              className={cn(
                                'flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent pointer-coarse:min-h-11',
                                presentation.isActive
                                  ? 'bg-accent/60 font-medium text-foreground'
                                  : 'text-muted-foreground hover:text-foreground',
                              )}
                              aria-label={`Open ${presentation.label}, ${presentation.location}`}
                              aria-current={
                                presentation.isCurrent ? 'page' : undefined
                              }
                              onClick={() => onNavigateEntry(r)}
                            >
                              {r.type === 'folder' ? (
                                <Folder className="size-3.5 shrink-0" />
                              ) : (
                                <File className="size-3.5 shrink-0" />
                              )}
                              <span className="flex min-w-0 flex-col">
                                <span className="truncate">
                                  {presentation.label}
                                </span>
                                <span className="truncate text-xs font-normal text-muted-foreground">
                                  {presentation.location}
                                </span>
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </section>
                )}
              </>
            )}
          </>
        )}
      </TabsContent>
    </Tabs>
  )
}

function QuickAccessSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-2 py-2" aria-busy="true">
      <Skeleton className="h-4 w-20 rounded-sm" />
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} className="h-9 rounded-sm" />
      ))}
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
  focusedKey: string | null
  onFocusKey: (key: string | null) => void
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
  focusedKey,
  onFocusKey,
}: TreeLevelProps) {
  const query = useInfiniteListFiles(parent, storageName)
  const loadMoreKey = `load-more:${parent}`

  const folders = useMemo(() => {
    const dirs =
      query.data?.pages.flatMap((page) =>
        page.entries.filter((entry) => entry.is_dir),
      ) ?? []
    return sortEntries(dirs, sortDir)
  }, [query.data?.pages, sortDir])

  useEffect(() => {
    if (query.isPending) return
    const nextFocus = reconcileTreeFocus(
      focusedKey,
      parent,
      folders.map((folder) => folder.key),
      query.hasNextPage,
    )
    if (nextFocus !== focusedKey) onFocusKey(nextFocus)
  }, [
    folders,
    focusedKey,
    onFocusKey,
    parent,
    query.hasNextPage,
    query.isPending,
  ])

  if (query.isPending) {
    return <LevelSkeleton depth={depth} />
  }

  if (query.isError && query.data === undefined) {
    return (
      <LevelError
        depth={depth}
        message={describeQueryError(query.error)}
        onRetry={() => void query.refetch()}
        isRetrying={query.isFetching}
      />
    )
  }

  if (folders.length === 0 && !query.hasNextPage) {
    return <LevelEmpty depth={depth} atRoot={parent === ''} />
  }

  return (
    <ul
      role="group"
      aria-busy={query.isFetching}
      className="flex flex-col gap-0.5"
    >
      {folders.map((entry, index) => (
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
          focusedKey={focusedKey}
          tabStop={
            focusedKey === entry.key ||
            (focusedKey === null && depth === 0 && index === 0)
          }
          onFocusKey={onFocusKey}
        />
      ))}
      {query.hasNextPage && (
        <li role="none">
          <Button
            role="treeitem"
            data-tree-key={loadMoreKey}
            data-tree-depth={depth}
            tabIndex={
              focusedKey === loadMoreKey ||
              (focusedKey === null && depth === 0 && folders.length === 0)
                ? 0
                : -1
            }
            variant="ghost"
            size="sm"
            aria-level={depth + 1}
            aria-disabled={query.isFetchingNextPage}
            onClick={() => {
              if (!query.isFetchingNextPage) void query.fetchNextPage()
            }}
            onFocus={() => onFocusKey(loadMoreKey)}
            className="h-7 max-w-full justify-start text-xs text-muted-foreground aria-disabled:pointer-events-none aria-disabled:opacity-50"
            style={{ marginLeft: depth * 12 + 24 }}
          >
            {query.isFetchingNextPage ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
            {query.isFetchingNextPage
              ? 'Loading folders…'
              : query.isFetchNextPageError
                ? 'Retry loading folders'
                : 'Load more folders'}
          </Button>
        </li>
      )}
      {query.isFetching && !query.isFetchingNextPage && (
        <li role="status" className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Refreshing folders…
        </li>
      )}
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
  focusedKey: string | null
  tabStop: boolean
  onFocusKey: (key: string | null) => void
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
  focusedKey,
  tabStop,
  onFocusKey,
}: TreeNodeProps) {
  const name = basenameOf(entry.key)
  // depth=0 in multi-bucket S3 IS the bucket level — everything deeper is
  // a regular folder regardless of mode.
  const isBucket = multiBucket && depth === 0
  const dir = dirVisual(isBucket)
  const isCurrent = entry.key === activePrefix
  const isExpanded = expand.isExpanded(entry.key)
  const rowRef = useRef<HTMLButtonElement | null>(null)

  // Reveal the active row after auto-expand opens its ancestors. `nearest`
  // avoids scrolling when the row is already on screen (e.g. shallow paths).
  useEffect(() => {
    if (isCurrent) {
      rowRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [isCurrent])

  return (
    <li role="none">
      <EntryContextMenu entry={entry} storageName={storageName}>
        <div
          data-tree-row
          className={cn(
            'flex w-full items-center rounded-md text-sm transition-colors',
            isCurrent
              ? 'bg-muted font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label={isExpanded ? `Collapse ${name}` : `Expand ${name}`}
            aria-expanded={isExpanded}
            data-tree-toggle
            onClick={(e) => {
              e.stopPropagation()
              onFocusKey(entry.key)
              rowRef.current?.focus()
              expand.toggle(entry.key)
            }}
            className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground pointer-coarse:size-11"
            style={{ marginLeft: depth * 12 }}
          >
            {isExpanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
          <button
            ref={rowRef}
            type="button"
            role="treeitem"
            data-tree-key={entry.key}
            data-tree-depth={depth}
            tabIndex={tabStop ? 0 : -1}
            onClick={() => {
              onNavigate(entry.key)
              expand.open(entry.key)
            }}
            onFocus={() => onFocusKey(entry.key)}
            aria-current={isCurrent ? 'page' : undefined}
            aria-expanded={isExpanded}
            aria-level={depth + 1}
            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
            title={name}
          >
            <EntryIcon
              Icon={dir.Icon}
              color={dir.color}
              isSymlink={entry.is_symlink}
              className="size-4 shrink-0"
            />
            <span className="truncate">{name}</span>
          </button>
        </div>
      </EntryContextMenu>
      {isExpanded && (
        <TreeLevel
          parent={entry.key}
          depth={depth + 1}
          activePrefix={activePrefix}
          storageName={storageName}
          multiBucket={multiBucket}
          sortDir={sortDir}
          expand={expand}
          onNavigate={onNavigate}
          focusedKey={focusedKey}
          onFocusKey={onFocusKey}
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
