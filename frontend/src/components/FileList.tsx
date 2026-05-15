import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom'
import {
  AlertCircle,
  ArrowDownAZ,
  ArrowDownZA,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Folder,
  Loader2,
  LogOut,
  PanelLeft,
  PanelLeftClose,
  RotateCw,
  Share2,
  X,
} from 'lucide-react'

import { ApiError, getStoredToken, setStoredToken } from '@/api/client'
import { proxyUrl } from '@/api/storage'
import { useListFiles, useServerInfo, useStorages } from '@/hooks/use-storage'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { useSidebarCollapsed } from '@/hooks/use-sidebar-collapsed'
import { useSortDir } from '@/hooks/use-sort-dir'
import { useViewMode } from '@/hooks/use-view-mode'
import { cn } from '@/lib/utils'
import { formatBytes, formatTime } from '@/lib/format'
import { sortEntries } from '@/lib/sort'
import { EntryContextMenu } from '@/components/EntryContextMenu'
import { FileGrid } from '@/components/FileGrid'
import { PathBreadcrumb } from '@/components/PathBreadcrumb'
import { PathNavigator } from '@/components/PathNavigator'
import { PreviewModal } from '@/components/PreviewModal'
import { Sidebar } from '@/components/Sidebar'
import {
  FOLDER_COLOR,
  colorForKey,
  getPreviewType,
  iconForKey,
  previewableKind,
  typeLabelForEntry,
} from '@/components/preview/registry'
import type { PreviewKind } from '@/components/preview/types'
import { StorageSwitcher } from '@/components/StorageSwitcher'
import { TokenPrompt } from '@/components/TokenPrompt'
import { ViewToggle } from '@/components/ViewToggle'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { FileEntry } from '@/types/storage'

const PREVIEW_PARAM = 'preview'
const REPO_URL = 'https://github.com/maoXyzt/omni-stream'

// Inline GitHub mark. `lucide-react` is brand-neutral so the official octocat
// isn't shipped there; this is the standard 16x16 path from GitHub's own
// invertocat asset, recoloured via `currentColor` so it inherits the button's
// foreground.
function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

export function FileList() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const params = useParams()
  const [searchParams, setSearchParams] = useSearchParams()

  const storageName = params.storage ?? ''
  // React Router exposes the catch-all match under the `*` key. Normalize so
  // every non-empty prefix ends with `/` to match the backend's directory
  // convention (e.g. `videos/` not `videos`).
  const rawSplat = params['*'] ?? ''
  const prefix = useMemo(() => normalizePrefix(rawSplat), [rawSplat])
  const parentInfo = useMemo(() => parentOf(prefix), [prefix])

  const storagesQuery = useStorages()
  const serverInfo = useServerInfo()
  const [viewMode, setViewMode] = useViewMode()
  // Inline split layout (narrow file list + preview pane) needs horizontal
  // room. Below `md` we keep the full-width list and fall back to the modal.
  const isDesktop = useMediaQuery('(min-width: 768px)')
  const [sortDir, setSortDir] = useSortDir()
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapsed()
  // Left-column width for the split layout — draggable, persisted per-user.
  // Bounds chosen to keep both columns usable on a 1280-wide viewport: never
  // less than ~200 px (enough for a short filename + icon) and never more
  // than ~600 px (otherwise the preview column collapses).
  const splitResize = useResizableWidth({
    key: 'gallery-file-list',
    defaultPx: 288,
    minPx: 200,
    maxPx: 600,
  })
  const [tokenStack, setTokenStack] = useState<Array<string | undefined>>([
    undefined,
  ])
  const currentToken = tokenStack[tokenStack.length - 1]
  const listQuery = useListFiles(prefix, currentToken, storageName || undefined)

  const previewName = searchParams.get(PREVIEW_PARAM)
  const previewState = useMemo(() => {
    if (!previewName) return null
    const kind = previewableKind(previewName)
    if (!kind) return null
    return { key: prefix + previewName, kind }
  }, [previewName, prefix])

  // `keepPreviousData` keeps the previous prefix's entries visible while
  // the new listing loads — useful for paginating within a prefix, but
  // when the user descends into a subfolder the carry-over entries don't
  // start with the new prefix and render with their full paths until the
  // fresh data lands. Detect that mismatch and treat it as loading.
  const isStaleForPrefix = useMemo(() => {
    const sample = listQuery.data?.entries[0]
    return Boolean(sample) && !sample!.key.startsWith(prefix)
  }, [listQuery.data, prefix])
  const showListSkeleton = listQuery.isPending || isStaleForPrefix

  // Ignore directory jumps fired within this window after a previous one.
  // Cached + `keepPreviousData` listings can re-render the row layout almost
  // instantly after a click, so the second tick of a double-click lands on a
  // new folder at the same screen position — the user sees one click descend
  // two levels. Throttling at `goToPath` (rather than inside the row click
  // handler) covers the file list, sidebar, and breadcrumb in one place.
  const lastDirNavRef = useRef(0)
  const goToPath = useCallback(
    (nextPrefix: string) => {
      const now = performance.now()
      if (now - lastDirNavRef.current < 300) return
      lastDirNavRef.current = now
      // Clearing page state when switching directories is intentional: the
      // page_token cursor returned by S3 is scoped to a specific prefix.
      setTokenStack([undefined])
      const clean = normalizePrefix(nextPrefix)
      const trail = clean ? clean : ''
      navigate({
        pathname: `/s/${encodeURIComponent(storageName)}/${trail}`,
        search: '',
      })
    },
    [navigate, storageName],
  )

  const switchStorage = useCallback(
    (name: string) => {
      if (name === storageName) return
      setTokenStack([undefined])
      navigate({
        pathname: `/s/${encodeURIComponent(name)}/`,
        search: '',
      })
    },
    [navigate, storageName],
  )

  const openPreview = useCallback(
    (entry: FileEntry) => {
      const rel = stripPrefix(entry.key, prefix)
      setSearchParams(
        (sp) => {
          const next = new URLSearchParams(sp)
          next.set(PREVIEW_PARAM, rel)
          return next
        },
        { replace: false },
      )
    },
    [prefix, setSearchParams],
  )

  const closePreview = useCallback(() => {
    setSearchParams(
      (sp) => {
        const next = new URLSearchParams(sp)
        next.delete(PREVIEW_PARAM)
        return next
      },
      { replace: false },
    )
  }, [setSearchParams])

  // Keyboard navigation only steps through the previewable subset of the
  // current page — pagination boundaries are deliberate stops since the next
  // page hasn't been fetched yet.
  const previewableEntries = useMemo(
    () =>
      (listQuery.data
        ? sortEntries(listQuery.data.entries, sortDir)
        : []
      ).filter((e) => !e.is_dir && previewableKind(e.key)),
    [listQuery.data, sortDir],
  )

  const navigatePreview = useCallback(
    (dir: 'prev' | 'next') => {
      if (!previewState || previewableEntries.length === 0) return
      const idx = previewableEntries.findIndex(
        (e) => e.key === previewState.key,
      )
      if (idx < 0) return
      const nextIdx = dir === 'next' ? idx + 1 : idx - 1
      if (nextIdx < 0 || nextIdx >= previewableEntries.length) return
      openPreview(previewableEntries[nextIdx])
    },
    [previewState, previewableEntries, openPreview],
  )

  // Split layout = list view on desktop with a preview open. Grid + mobile
  // continue to use the modal preview path.
  const splitView =
    viewMode === 'list' && isDesktop && previewState !== null

  // Arrow-key nav + Esc-to-close for the split layout. The modal handles its
  // own keys via Radix Dialog; this only fires when the inline preview is
  // active. Skip when focus is in a control where keys are meaningful.
  useEffect(() => {
    if (!splitView) return
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          tag === 'VIDEO' ||
          tag === 'AUDIO' ||
          target.isContentEditable
        ) {
          return
        }
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault()
        navigatePreview('next')
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault()
        navigatePreview('prev')
      } else if (e.key === 'Escape') {
        e.preventDefault()
        closePreview()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [splitView, navigatePreview, closePreview])

  // Backspace = up one directory. No-op at storage root. Skipped while a
  // preview is open so Esc-to-close keeps priority, and skipped when focus is
  // in an editable control where Backspace deletes characters.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Backspace') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return
        }
      }
      if (previewState) return
      if (!parentInfo) return
      e.preventDefault()
      goToPath(parentInfo.parent)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [previewState, parentInfo, goToPath])

  const sortedEntries = useMemo(
    () => (listQuery.data ? sortEntries(listQuery.data.entries, sortDir) : []),
    [listQuery.data, sortDir],
  )

  // Scroll-to-top: the shell's main element is the scroll container (sidebar
  // and main scroll independently), so we listen on the ref rather than on
  // window. Threshold 100px = roughly "user has scrolled past the toolbar".
  const mainRef = useRef<HTMLElement>(null)
  const [scrolled, setScrolled] = useState(false)
  const handleMainScroll = useCallback(() => {
    const el = mainRef.current
    if (!el) return
    setScrolled(el.scrollTop > 100)
  }, [])
  const scrollToTop = useCallback(() => {
    mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  // Once we know the storages roster, validate the URL's storage name. If it
  // doesn't exist, bounce to the server's default rather than rendering a
  // perpetual 404 for a typo'd / removed backend.
  if (
    storagesQuery.data &&
    !storagesQuery.data.storages.some((s) => s.name === storageName)
  ) {
    return (
      <Navigate
        to={`/s/${encodeURIComponent(storagesQuery.data.default)}/`}
        replace
      />
    )
  }

  const isAuthError =
    (listQuery.isError &&
      listQuery.error instanceof ApiError &&
      listQuery.error.status === 401) ||
    (storagesQuery.isError &&
      storagesQuery.error instanceof ApiError &&
      storagesQuery.error.status === 401)

  if (isAuthError) {
    return (
      <TokenPrompt
        onSubmit={() => {
          queryClient.invalidateQueries()
        }}
      />
    )
  }

  const hasToken = getStoredToken() !== null

  function nextPage() {
    if (listQuery.data?.next_token) {
      setTokenStack((stack) => [...stack, listQuery.data!.next_token!])
    }
  }

  function prevPage() {
    setTokenStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack))
  }

  function handleEntry(entry: FileEntry) {
    if (entry.is_dir) {
      goToPath(entry.key)
      return
    }
    // Every file is previewable — known types via their dedicated previewer,
    // unknown types via GenericPreview (icon + metadata + iframe fallback for
    // PDFs). The preview modal's footer still exposes Open/Download for
    // formats the user'd rather just grab.
    openPreview(entry)
  }

  // Keep sidebar visible even at the storage root so the main pane's width
  // doesn't reflow on navigation. At root the up button is omitted but the
  // panel still shows root-level folders for quick jumps.
  const sidebarParent = parentInfo?.parent ?? ''
  const sidebarCurrent = parentInfo?.currentName ?? ''
  const toggleMainSort = () => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')

  return (
    <div className="flex h-screen w-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-background px-6 py-3">
        <h1 className="text-2xl font-semibold">
          OmniStream
          {serverInfo.data?.hostname && (
            <span className="ml-2 text-base font-normal text-muted-foreground">
              {serverInfo.data.hostname}
            </span>
          )}
        </h1>
        {storagesQuery.data && (
          <StorageSwitcher
            storages={storagesQuery.data.storages}
            active={storageName}
            onChange={switchStorage}
          />
        )}
        {/* `ml-auto` floats this to the right edge regardless of how many
            other items live in the header; `asChild` lets the Button styles
            apply to the underlying anchor so the link still opens in a new
            tab with `noopener noreferrer`. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" asChild className="ml-auto">
              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View source on GitHub"
              >
                <GithubIcon className="size-4" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>View source on GitHub</TooltipContent>
        </Tooltip>
      </header>

      <div className="flex min-h-0 flex-1">
        {storageName && !sidebarCollapsed && (
          <aside className="hidden md:flex md:w-64 md:shrink-0 md:flex-col md:overflow-y-auto md:border-r md:border-border">
            <Sidebar
              parent={sidebarParent}
              currentName={sidebarCurrent}
              storageName={storageName}
              onNavigate={goToPath}
            />
          </aside>
        )}
        <main
          ref={mainRef}
          onScroll={handleMainScroll}
          className="flex w-full min-w-0 flex-col gap-4 overflow-y-auto px-6 py-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {storageName && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
                      aria-pressed={!sidebarCollapsed}
                      onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                      className="hidden md:inline-flex"
                    >
                      {sidebarCollapsed ? (
                        <PanelLeft className="size-4" />
                      ) : (
                        <PanelLeftClose className="size-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {sidebarCollapsed ? 'Show folder sidebar' : 'Hide folder sidebar'}
                  </TooltipContent>
                </Tooltip>
              )}
              <PathBreadcrumb prefix={prefix} onNavigate={goToPath} />
              <PathNavigator prefix={prefix} onNavigate={goToPath} />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={sortDir === 'asc' ? 'Sort descending' : 'Sort ascending'}
                    aria-pressed={sortDir === 'desc'}
                    onClick={toggleMainSort}
                  >
                    {sortDir === 'asc' ? (
                      <ArrowDownAZ className="size-4" />
                    ) : (
                      <ArrowDownZA className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {sortDir === 'asc'
                    ? 'Sort A→Z (click to flip to Z→A)'
                    : 'Sort Z→A (click to flip to A→Z)'}
                </TooltipContent>
              </Tooltip>
              <ViewToggle mode={viewMode} onChange={setViewMode} />
              <ShareLinkButton />
              {hasToken && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label="Sign out"
                      onClick={() => {
                        setStoredToken(null)
                        queryClient.invalidateQueries()
                      }}
                    >
                      <LogOut className="size-4" />
                      Sign out
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Clear the stored bearer token</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>

          {listQuery.isError && (
            <ErrorState
              error={listQuery.error}
              onRetry={() => void listQuery.refetch()}
              isRetrying={listQuery.isFetching}
            />
          )}

      {showListSkeleton ? (
        viewMode === 'grid' ? (
          <GridSkeleton />
        ) : splitView ? (
          <GallerySkeleton />
        ) : (
          <ListSkeleton />
        )
      ) : listQuery.data ? (
        splitView ? (
          <div className="flex min-h-0 flex-1">
            <div
              style={{ width: splitResize.width }}
              className="flex shrink-0 flex-col gap-2 overflow-hidden pr-3"
            >
              <Pager
                hasPrev={tokenStack.length > 1}
                hasNext={Boolean(listQuery.data.next_token)}
                isFetching={listQuery.isFetching}
                onPrev={prevPage}
                onNext={nextPage}
              />
              {/* Clicking the column's empty area (below the rows or in the
                  gap between Pager and rows) closes the preview. Row clicks
                  bubble up but `e.target !== currentTarget` so they don't
                  trigger the close. */}
              <div
                onClick={(e) => {
                  if (e.target === e.currentTarget) closePreview()
                }}
                className="flex min-h-0 flex-1 flex-col overflow-y-auto"
              >
                {sortedEntries.length === 0 ? (
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    Empty directory.
                  </div>
                ) : (
                  sortedEntries.map((entry) => (
                    <GalleryRow
                      key={entry.key}
                      entry={entry}
                      prefix={prefix}
                      storageName={storageName}
                      selected={previewState?.key === entry.key}
                      onSelect={handleEntry}
                    />
                  ))
                )}
              </div>
            </div>
            <ResizeHandle onPointerDown={splitResize.startResize} />
            <div className="flex min-w-0 flex-1 flex-col pl-3">
              <div className="mb-2 flex items-center gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Close preview"
                      onClick={closePreview}
                    >
                      <X className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Close preview (Esc)</TooltipContent>
                </Tooltip>
                <span
                  className="truncate text-sm text-muted-foreground"
                  title={previewState!.key}
                >
                  {previewState!.key}
                </span>
              </div>
              <InlinePreview
                fileKey={previewState!.key}
                kind={previewState!.kind}
                storage={storageName || undefined}
              />
            </div>
          </div>
        ) : (
          <>
            <Pager
              hasPrev={tokenStack.length > 1}
              hasNext={Boolean(listQuery.data.next_token)}
              isFetching={listQuery.isFetching}
              onPrev={prevPage}
              onNext={nextPage}
            />

            {viewMode === 'grid' ? (
              <FileGrid
                entries={sortedEntries}
                prefix={prefix}
                storageName={storageName}
                onSelect={handleEntry}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-1/2">Name</TableHead>
                    <TableHead className="w-28">Type</TableHead>
                    <TableHead className="w-32 text-right">Size</TableHead>
                    <TableHead>Modified</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedEntries.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="text-center text-muted-foreground py-10"
                      >
                        Empty directory.
                      </TableCell>
                    </TableRow>
                  )}
                  {sortedEntries.map((entry) => (
                    <FileRow
                      key={entry.key}
                      entry={entry}
                      prefix={prefix}
                      storageName={storageName}
                      onSelect={handleEntry}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )
      ) : null}

        </main>
      </div>

      {scrolled && (
        <Button
          variant="default"
          size="icon"
          aria-label="Back to top"
          title="Back to top"
          onClick={scrollToTop}
          className="fixed bottom-6 right-6 z-50 size-12 rounded-full shadow-xl"
        >
          <ArrowUp className="size-5" />
        </Button>
      )}

      {/* Backend version chip in the bottom-left, fixed so it survives scroll
          and modal overlays. `pointer-events-none` lets clicks pass through
          to whatever's underneath (e.g. the sidebar) since the chip is
          purely informational. */}
      {serverInfo.data?.version && (
        <div className="pointer-events-none fixed bottom-2 left-2 z-30 rounded-md border bg-background/70 px-2 py-0.5 font-mono text-[10px] text-muted-foreground/80 shadow-sm backdrop-blur supports-backdrop-filter:bg-background/50">
          v{serverInfo.data.version}
        </div>
      )}

      {previewState && !splitView && (
        <PreviewModal
          fileKey={previewState.key}
          kind={previewState.kind}
          storage={storageName || undefined}
          onClose={closePreview}
          onNavigate={navigatePreview}
        />
      )}
    </div>
  )
}

function ShareLinkButton() {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(t)
  }, [copied])

  async function onClick() {
    const url = window.location.href
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
        setCopied(true)
        return
      }
    } catch {
      // fall through to prompt
    }
    window.prompt('Copy this link:', url)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="sm" onClick={onClick}>
          {copied ? (
            <>
              <Check className="size-4" />
              Copied
            </>
          ) : (
            <>
              <Share2 className="size-4" />
              Share link
            </>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {copied ? 'Link copied to clipboard' : 'Copy a shareable link to this view'}
      </TooltipContent>
    </Tooltip>
  )
}

interface FileRowProps {
  entry: FileEntry
  prefix: string
  storageName: string
  onSelect: (entry: FileEntry) => void
}

function FileRow({ entry, prefix, storageName, onSelect }: FileRowProps) {
  const Icon = entry.is_dir ? Folder : iconForKey(entry.key)
  const color = entry.is_dir ? FOLDER_COLOR : colorForKey(entry.key)
  const name = displayName(entry.key, prefix)
  const typeLabel = typeLabelForEntry(entry.key, entry.is_dir)

  return (
    <EntryContextMenu entry={entry} storageName={storageName}>
      <TableRow
        className="cursor-pointer hover:bg-muted/50"
        onClick={() => onSelect(entry)}
      >
        <TableCell className="flex items-center gap-2 truncate">
          <Icon className={`size-4 shrink-0 ${color}`} />
          <span className="truncate" title={name}>
            {name}
          </span>
        </TableCell>
        <TableCell className="text-muted-foreground">{typeLabel}</TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">
          {entry.is_dir ? '—' : formatBytes(entry.size)}
        </TableCell>
        <TableCell className="text-muted-foreground">
          {formatTime(entry.last_modified)}
        </TableCell>
      </TableRow>
    </EntryContextMenu>
  )
}

interface ResizeHandleProps {
  onPointerDown: (e: ReactPointerEvent) => void
}

// 4-px-wide column separator that captures pointer drags. `bg-border` matches
// the existing border-color used elsewhere; the hover/active states tint it
// with the primary color so the affordance is discoverable without being
// noisy at rest.
function ResizeHandle({ onPointerDown }: ResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className="group relative w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/40 active:bg-primary/60"
    >
      {/* Invisible 8-px-wide hit area centered over the visible bar so users
          don't need pixel-perfect aim to grab the handle. */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 -left-1.5 w-4"
      />
    </div>
  )
}

interface GalleryRowProps {
  entry: FileEntry
  prefix: string
  storageName: string
  selected: boolean
  onSelect: (entry: FileEntry) => void
}

function GalleryRow({
  entry,
  prefix,
  storageName,
  selected,
  onSelect,
}: GalleryRowProps) {
  const Icon = entry.is_dir ? Folder : iconForKey(entry.key)
  const color = entry.is_dir ? FOLDER_COLOR : colorForKey(entry.key)
  const name = displayName(entry.key, prefix)
  const ref = useRef<HTMLButtonElement>(null)

  // Keep DOM focus aligned with the visual "selected" highlight. Arrow-key
  // nav changes `previewState` but does not touch the focused element, so
  // without this the focus ring sits stale on the originally-clicked row
  // while the highlight drifts away — and the new row can scroll out of
  // view since nothing triggers a scrollIntoView. `preventScroll: true` on
  // focus then `block: 'nearest'` keeps the layout from jumping when the
  // row is already visible.
  useEffect(() => {
    if (!selected) return
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <EntryContextMenu entry={entry} storageName={storageName}>
      <button
        ref={ref}
        type="button"
        onClick={() => onSelect(entry)}
        title={name}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
          selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50',
        )}
      >
        <Icon className={`size-4 shrink-0 ${color}`} />
        <span className="truncate">{name}</span>
      </button>
    </EntryContextMenu>
  )
}

interface InlinePreviewProps {
  fileKey: string
  kind: PreviewKind
  storage?: string
}

function InlinePreview({ fileKey, kind, storage }: InlinePreviewProps) {
  const src = proxyUrl(fileKey, storage)
  const Previewer = getPreviewType(kind)?.Component
  if (!Previewer) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
        No previewer registered for this file.
      </div>
    )
  }
  return (
    <div className="flex h-full w-full min-h-0">
      <Previewer fileKey={fileKey} src={src} storage={storage} />
    </div>
  )
}

interface PagerProps {
  hasPrev: boolean
  hasNext: boolean
  isFetching: boolean
  onPrev: () => void
  onNext: () => void
}

function Pager({ hasPrev, hasNext, isFetching, onPrev, onNext }: PagerProps) {
  if (!hasPrev && !hasNext) return null
  return (
    <div className="flex justify-end gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={!hasPrev || isFetching}
        onClick={onPrev}
      >
        <ChevronLeft className="size-4" />
        Prev
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!hasNext || isFetching}
        onClick={onNext}
      >
        Next
        <ChevronRight className="size-4" />
      </Button>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  )
}

function GallerySkeleton() {
  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <div className="flex w-72 shrink-0 flex-col gap-2 border-r border-border pr-3">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
      <div className="flex min-w-0 flex-1">
        <Skeleton className="h-full w-full" />
      </div>
    </div>
  )
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10">
      {Array.from({ length: 20 }).map((_, i) => (
        <Skeleton key={i} className="aspect-square w-full rounded-md" />
      ))}
    </div>
  )
}

interface ErrorStateProps {
  error: unknown
  onRetry?: () => void
  isRetrying?: boolean
}

function ErrorState({ error, onRetry, isRetrying }: ErrorStateProps) {
  const message =
    error instanceof ApiError
      ? `${error.status} — ${error.message}`
      : error instanceof Error
        ? error.message
        : 'Unknown error.'
  return (
    <Alert variant="destructive">
      <AlertCircle className="size-4" />
      <AlertTitle>Failed to load directory</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <span>{message}</span>
        {onRetry && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            disabled={isRetrying}
            className="self-start"
          >
            {isRetrying ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RotateCw className="size-4" />
            )}
            Retry
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

function normalizePrefix(value: string): string {
  const trimmed = value.replace(/^\/+/, '')
  if (!trimmed) return ''
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/// Split a normalized prefix into (parent prefix, current dir name). Returns
/// null at the storage root — no sidebar in that case.
function parentOf(prefix: string): { parent: string; currentName: string } | null {
  if (!prefix) return null
  const stripped = prefix.replace(/\/+$/, '')
  const lastSlash = stripped.lastIndexOf('/')
  if (lastSlash < 0) {
    return { parent: '', currentName: stripped }
  }
  return {
    parent: stripped.slice(0, lastSlash + 1),
    currentName: stripped.slice(lastSlash + 1),
  }
}

function stripPrefix(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key
}

function displayName(key: string, prefix: string): string {
  const rel = key.startsWith(prefix) ? key.slice(prefix.length) : key
  return rel.replace(/\/+$/, '') || key
}

