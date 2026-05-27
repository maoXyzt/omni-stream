import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
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
  Loader2,
  LogOut,
  PanelLeft,
  PanelLeftClose,
  RotateCw,
  Search,
  Share2,
  X,
} from 'lucide-react'

import { ApiError, getStoredToken, setStoredToken } from '@/api/client'
import { listFiles, proxyUrl, statFile } from '@/api/storage'
import { isMultiBucketS3 } from '@/lib/storage-display'
import { resolveStorageUri } from '@/lib/resolve-uri'
import {
  useListFiles,
  usePrefetchListFiles,
  useServerInfo,
  useStorages,
} from '@/hooks/use-storage'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { useSidebarCollapsed } from '@/hooks/use-sidebar-collapsed'
import { useSortDir } from '@/hooks/use-sort-dir'
import { useGridFit } from '@/hooks/use-grid-fit'
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
  colorForKey,
  dirVisual,
  getPreviewType,
  iconForKey,
  previewableKind,
  typeLabelForEntry,
} from '@/components/preview/registry'
import type { PreviewKind } from '@/components/preview/types'
import { StorageSwitcher } from '@/components/StorageSwitcher'
import { TokenPrompt } from '@/components/TokenPrompt'
import { GridFitToggle } from '@/components/GridFitToggle'
import { ViewToggle } from '@/components/ViewToggle'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
const PAGE_PARAM = 'page'
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
  const activeStorage = useMemo(
    () => storagesQuery.data?.storages.find((s) => s.name === storageName),
    [storagesQuery.data, storageName],
  )
  // True only when this storage hands out raw buckets at the root (S3
  // multi-bucket mode). Threaded into the list / grid / sidebar so entry
  // icons at the bucket level read as buckets, not folders.
  const multiBucket = isMultiBucketS3(activeStorage)
  const inBucketRoot = multiBucket && prefix === ''
  // For S3 storages configured in multi-bucket mode (`s3.bucket` omitted in
  // the server config → backend reports `bucket: null`), the URL's first
  // path segment IS the bucket name. Surface it to the navbar switcher so it
  // can render "current bucket" instead of just an opaque "*".
  const currentBucket = useMemo<string | null>(() => {
    if (!multiBucket) return null
    const first = prefix.split('/')[0]
    return first || null
  }, [multiBucket, prefix])
  const [viewMode, setViewMode] = useViewMode()
  const [gridFit, setGridFit] = useGridFit()
  // Inline split layout (narrow file list + preview pane) needs horizontal
  // room. Below `md` we keep the full-width list and fall back to the modal.
  const isDesktop = useMediaQuery('(min-width: 768px)')
  const [sortDir, setSortDir] = useSortDir()
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapsed()
  // Left-column width for the split layout — draggable, persisted per-user.
  // Bounds tuned so the filter+pager row sits comfortably:
  //  - min ~360 px → the Pager (Prev / Page input / "/ N" / Next) renders
  //    fully on one line even when it has to wrap below the FilterBar; below
  //    this the Pager's own children start to wrap, which reads as broken.
  //  - default ~420 px → on a typical 1440-wide viewport this fits an idle
  //    FilterBar + Pager on a single row without overflow, and only wraps
  //    to two rows when active-filter chips push the FilterBar wider.
  //  - max 600 px → preserves room for the right-hand preview column.
  const splitResize = useResizableWidth({
    key: 'gallery-file-list',
    defaultPx: 420,
    minPx: 360,
    maxPx: 600,
  })
  // Folder-tree sidebar. Min keeps short folder names readable; max prevents
  // it from eating the main pane on narrower viewports.
  const sidebarResize = useResizableWidth({
    key: 'sidebar',
    defaultPx: 256,
    minPx: 180,
    maxPx: 480,
  })
  // Cache of `page_token`s for the current prefix. Index `i` is the token
  // that fetches page (i + 1); `tokenStack[0]` is always `undefined`. Grows
  // as the user (or a server-side walk) discovers new pages. Reset on prefix
  // or storage change.
  const [tokenStack, setTokenStack] = useState<Array<string | undefined>>([
    undefined,
  ])
  // Current page is URL-driven so reload and shareable links work. 1-indexed
  // in the URL to match the UX.
  const pageParam = searchParams.get(PAGE_PARAM)
  const currentPage = Math.max(1, Math.floor(Number(pageParam)) || 1)
  // `undefined` in two cases: the URL points beyond what we've discovered
  // (triggers a walk below) OR currentPage is 1 (no token = page 1, the
  // existing behavior). useListFiles handles both: it keys on the token, so
  // walking and direct fetches share the same cache.
  const currentToken = tokenStack[currentPage - 1]
  const listQuery = useListFiles(prefix, currentToken, storageName || undefined)
  const prefetchListFiles = usePrefetchListFiles()
  // `walking` is the UI signal (Pager spinner + skeleton). `walkingRef`
  // mirrors it as a ref so the walk effect can guard re-entry without
  // listing `walking` in its dep array.
  const [walking, setWalking] = useState(false)
  const walkingRef = useRef(false)

  // Reset the token cache when (storage, prefix) changes — covers browser
  // back/forward and manual URL edits. The updater returns `prev` when the
  // stack is already `[undefined]` so the reference stays stable; otherwise
  // the mount-time reset would bump `tokenStack`'s identity and cancel any
  // in-flight walk via the walk effect's cleanup.
  useEffect(() => {
    setTokenStack((prev) =>
      prev.length === 1 && prev[0] === undefined ? prev : [undefined],
    )
  }, [prefix, storageName])

  const gotoPage = useCallback(
    (target: number) => {
      const safe = Math.max(1, Math.floor(target))
      setSearchParams(
        (sp) => {
          if (safe === 1) sp.delete(PAGE_PARAM)
          else sp.set(PAGE_PARAM, String(safe))
          return sp
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // When a page lands via direct fetch (Next click or first paint), record
  // its `next_token` at the right index so `tokenStack` grows one page at
  // a time. Skipped while a walk is in flight (walk owns the stack and
  // seeds it atomically) or while the URL points past the known range
  // (`listQuery.data` is then for page 1, not for `currentPage`).
  useEffect(() => {
    if (walkingRef.current) return
    if (!listQuery.data) return
    if (currentPage > tokenStack.length) return
    const nt = listQuery.data.next_token
    if (!nt) return
    setTokenStack((prev) => {
      // currentPage is 1-indexed; the next page's token lives at index N.
      if (prev[currentPage] === nt) return prev
      const next = prev.slice()
      next[currentPage] = nt
      return next
    })
  }, [listQuery.data, currentPage, tokenStack.length])

  // Prefetch the next page once the current one resolves so Next-click
  // navigation lands instantly. Skipped during a walk (the walker drives
  // its own multi-page fetch) and when the URL points past the known
  // range (`listQuery.data` is then page 1, not the user's target — the
  // walk effect below will catch up first). Same staleTime as
  // `useListFiles` so the prefetched entry survives until the consumer
  // mounts.
  const nextToken = listQuery.data?.next_token ?? null
  const knownPages = tokenStack.length
  useEffect(() => {
    if (walkingRef.current) return
    if (!storageName) return
    if (!nextToken) return
    if (currentPage > knownPages) return
    prefetchListFiles(prefix, nextToken, storageName || undefined)
  }, [nextToken, currentPage, knownPages, prefix, storageName, prefetchListFiles])

  // Walk-on-cold-cache: URL says page N but tokenStack only knows up to
  // page K (< N). One request with `skip_pages = N - K` returns the landed
  // page plus every intermediate token; seeding React Query's cache lets
  // the renderer below pick it up without a second round-trip. Larger
  // jumps re-enter this effect once the stack grows (server caps at
  // `MAX_SKIP_PAGES = 100`). `walkingRef` is the re-entry guard — see the
  // `[walking, walkingRef]` declaration above for why a ref, not state.
  useEffect(() => {
    if (!storageName) return
    if (walkingRef.current) return
    if (currentPage <= tokenStack.length) return
    const startIdx = tokenStack.length - 1
    const startToken = tokenStack[startIdx]
    const skip = currentPage - tokenStack.length
    walkingRef.current = true
    setWalking(true)
    let cancelled = false
    ;(async () => {
      try {
        const res = await listFiles(prefix, startToken, storageName, skip)
        if (cancelled) return
        const walked = res.walked_tokens ?? []
        const newStack = [...tokenStack, ...walked]
        // Seed React Query's cache for the landed page so the existing
        // useListFiles consumer renders immediately without an extra fetch.
        // `landedToken` is the token that fetches the landed page itself —
        // the last element of newStack after appending walked tokens.
        const landedToken = newStack[newStack.length - 1]
        queryClient.setQueryData(
          ['list', storageName, prefix, landedToken ?? null],
          { entries: res.entries, next_token: res.next_token },
        )
        if (res.next_token) newStack.push(res.next_token)
        setTokenStack(newStack)
        // If the listing ran out before we reached the URL's page, snap the
        // URL back to whatever the actual last page turned out to be — and
        // surface a toast so the user knows their input was clamped rather
        // than wondering why the page number "snapped" silently.
        const actualLastPage = newStack.length - (res.next_token ? 1 : 0)
        if (actualLastPage < currentPage) {
          gotoPage(actualLastPage)
          toast.info(
            `Page ${currentPage.toLocaleString()} doesn't exist — showing last page (${actualLastPage.toLocaleString()}).`,
          )
        }
      } catch (err) {
        if (cancelled) return
        // 408 comes from the server-side TimeoutLayer on `/api/list`. Tell
        // the user concretely, then snap the URL back to the last page we
        // already know how to fetch so they're not stuck on a number that
        // never resolves. Other errors (network drop, 5xx) surface as a
        // generic toast — the React Query consumer below will retry on
        // its own when conditions change.
        const stuckPage = currentPage
        const fallbackPage = Math.max(1, tokenStack.length)
        if (err instanceof ApiError && err.status === 408) {
          toast.error(
            `Couldn't load page ${stuckPage.toLocaleString()} — the directory listing timed out. Try a smaller jump or use the filter.`,
          )
        } else {
          const msg = err instanceof Error ? err.message : 'unknown error'
          toast.error(`Failed to load page ${stuckPage.toLocaleString()}: ${msg}`)
        }
        if (fallbackPage < currentPage) gotoPage(fallbackPage)
      } finally {
        // `cancelled` gates state writes in the body, but the UI flag
        // always releases — otherwise a cancelled walk would leave the
        // skeleton stuck on.
        walkingRef.current = false
        setWalking(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currentPage, tokenStack, prefix, storageName, queryClient, gotoPage])

  // Client-side filters, scoped to the current page only. Filters reset on
  // prefix change (entering a new directory wants a fresh view); they
  // persist across pagination within the same prefix.
  const [nameFilter, setNameFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  useEffect(() => {
    setNameFilter('')
    setTypeFilter('')
  }, [prefix])

  const previewName = searchParams.get(PREVIEW_PARAM)
  const previewState = useMemo(() => {
    if (!previewName) return null
    const kind = previewableKind(previewName)
    if (!kind) return null
    return { key: prefix + previewName, kind }
  }, [previewName, prefix])

  // Look up the entry currently being previewed so we can pass its
  // last_modified into the previewer as a cache buster. Falls back to null
  // when the listing hasn't loaded yet, or when the user shared a URL to a
  // file that's no longer present.
  const previewVersion = useMemo(() => {
    if (!previewState || !listQuery.data) return null
    return (
      listQuery.data.entries.find((e) => e.key === previewState.key)
        ?.last_modified ?? null
    )
  }, [previewState, listQuery.data])

  // `keepPreviousData` keeps the previous prefix's entries visible while
  // the new listing loads — useful for paginating within a prefix, but
  // when the user descends into a subfolder the carry-over entries don't
  // start with the new prefix and render with their full paths until the
  // fresh data lands. Detect that mismatch and treat it as loading.
  const isStaleForPrefix = useMemo(() => {
    const sample = listQuery.data?.entries[0]
    return Boolean(sample) && !sample!.key.startsWith(prefix)
  }, [listQuery.data, prefix])
  // During a server-side walk we haven't populated `tokenStack[currentPage-1]`
  // yet, so `useListFiles` is reading page 1's listing under the hood — render
  // the skeleton until the walk seeds the cache + updates the stack.
  const showListSkeleton = listQuery.isPending || isStaleForPrefix || walking

  // Two sources of truth for the total: (1) the backend hint (local-fs has
  // it cheap, S3 doesn't ship it), and (2) frontend-discovered EOF — when
  // the current page's listing has `next_token === null`, `currentPage` IS
  // the last page. We prefer the backend hint when present because it's
  // available on page 1 already; we fall back to the EOF derivation so S3
  // users still see "Page X / Y" once they've walked or paged to the end.
  const totalPages = useMemo<number | null>(() => {
    if (showListSkeleton) return null
    const fromBackend = listQuery.data?.total_pages
    if (typeof fromBackend === 'number') return fromBackend
    if (listQuery.data && listQuery.data.next_token === null) return currentPage
    return null
  }, [listQuery.data, currentPage, showListSkeleton])

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

  // "Go to path" target may be a file rather than a directory. `goToPath`
  // (used by row clicks / breadcrumb / sidebar) always treats its input as a
  // directory and stays synchronous; this wrapper is only wired to
  // `PathNavigator`, where the pasted value is ambiguous. We first resolve a
  // full `s3://bucket/key` URI down to a path relative to the active storage
  // (rejected with a toast when it belongs elsewhere). Then an explicit
  // trailing slash (or empty input) means "directory" and skips the stat
  // round-trip; otherwise we stat to disambiguate, and for a file we jump to
  // its parent directory with the file's preview open — same end state as
  // clicking it.
  const goToPathOrFile = useCallback(
    async (input: string) => {
      const resolved = resolveStorageUri(input, activeStorage)
      if (!resolved.ok) {
        toast.error(resolved.reason)
        return
      }
      const trimmed = resolved.path.replace(/^\/+/, '')
      if (!trimmed || trimmed.endsWith('/')) {
        goToPath(trimmed)
        return
      }
      let meta
      try {
        meta = await statFile(trimmed, storageName || undefined)
      } catch {
        // Not found / network error: fall back to directory navigation so the
        // listing surfaces its existing 404/error state, matching prior behavior.
        goToPath(trimmed)
        return
      }
      if (meta.is_dir) {
        goToPath(trimmed)
        return
      }
      const slash = trimmed.lastIndexOf('/')
      const parent = slash >= 0 ? trimmed.slice(0, slash + 1) : ''
      const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
      const sp = new URLSearchParams()
      sp.set(PREVIEW_PARAM, base)
      setTokenStack([undefined])
      navigate({
        pathname: `/s/${encodeURIComponent(storageName)}/${parent}`,
        search: `?${sp.toString()}`,
      })
    },
    [goToPath, navigate, storageName, activeStorage],
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

  const sortedEntries = useMemo(
    () => (listQuery.data ? sortEntries(listQuery.data.entries, sortDir) : []),
    [listQuery.data, sortDir],
  )

  const filteredEntries = useMemo(() => {
    const q = nameFilter.trim().toLowerCase()
    if (!q && !typeFilter) return sortedEntries
    return sortedEntries.filter((e) => {
      if (q) {
        const name = displayName(e.key, prefix).toLowerCase()
        if (!name.includes(q)) return false
      }
      if (
        typeFilter &&
        typeLabelForEntry(e.key, e.is_dir, e.is_dir && inBucketRoot) !==
          typeFilter
      ) {
        return false
      }
      return true
    })
  }, [sortedEntries, nameFilter, typeFilter, prefix, inBucketRoot])

  // Types that actually appear in the current page — populated before
  // filtering so the dropdown stays stable as the user narrows down.
  const availableTypes = useMemo(() => {
    const set = new Set<string>()
    for (const e of sortedEntries) {
      set.add(typeLabelForEntry(e.key, e.is_dir, e.is_dir && inBucketRoot))
    }
    return Array.from(set).sort()
  }, [sortedEntries, inBucketRoot])

  const filtersActive = nameFilter !== '' || typeFilter !== ''
  const clearFilters = () => {
    setNameFilter('')
    setTypeFilter('')
  }

  // Keyboard navigation only steps through the previewable subset of the
  // current page — pagination boundaries are deliberate stops since the next
  // page hasn't been fetched yet. Filters apply here too so arrow keys
  // skip over rows the user hid.
  const previewableEntries = useMemo(
    () => filteredEntries.filter((e) => !e.is_dir && previewableKind(e.key)),
    [filteredEntries],
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

  // Stable across re-renders so memoized `FileTile`s in the grid don't
  // invalidate their cache every time the user types in the filter or flips
  // sort direction.
  const handleEntry = useCallback(
    (entry: FileEntry) => {
      if (entry.is_dir) {
        goToPath(entry.key)
        return
      }
      // Every file is previewable — known types via their dedicated previewer,
      // unknown types via GenericPreview (icon + metadata + iframe fallback
      // for PDFs). The preview modal's footer still exposes Open/Download for
      // formats the user'd rather just grab.
      openPreview(entry)
    },
    [goToPath, openPreview],
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
    gotoPage(currentPage + 1)
  }

  function prevPage() {
    gotoPage(currentPage - 1)
  }

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
            currentBucket={currentBucket}
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
          <>
            <aside
              style={{ width: sidebarResize.width }}
              className="hidden shrink-0 md:flex md:flex-col md:overflow-y-auto md:border-r md:border-border"
            >
              <Sidebar
                prefix={prefix}
                storageName={storageName}
                multiBucket={multiBucket}
                onNavigate={goToPath}
              />
            </aside>
            <ResizeHandle
              onPointerDown={sidebarResize.startResize}
              className="hidden md:block"
            />
          </>
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
              <PathNavigator prefix={prefix} onNavigate={goToPathOrFile} />
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label="Refresh listing"
                    onClick={() => {
                      // Invalidate every page of the current prefix — pagination
                      // tokens are S3-opaque and may not survive concurrent
                      // server-side adds/removes, but invalidating across all
                      // tokens is cheap and the user is already asking for a
                      // fresh read. Sidebar siblings stay cached.
                      void queryClient.invalidateQueries({
                        queryKey: ['list', storageName, prefix],
                      })
                    }}
                    disabled={listQuery.isFetching}
                  >
                    <RotateCw
                      className={cn(
                        'size-4',
                        listQuery.isFetching && 'animate-spin',
                      )}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Refresh listing</TooltipContent>
              </Tooltip>
              <ViewToggle mode={viewMode} onChange={setViewMode} />
              {viewMode === 'grid' && (
                <GridFitToggle fit={gridFit} onChange={setGridFit} />
              )}
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
              {/* Filter + pager share a row when they fit, then wrap to two
                  lines when the column is too narrow. `ml-auto` on the pager
                  keeps it right-aligned both when alone on a line and when
                  the FilterBar sits to its left. */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {sortedEntries.length > 0 && (
                  <FilterBar
                    nameValue={nameFilter}
                    onNameChange={setNameFilter}
                    typeValue={typeFilter}
                    onTypeChange={setTypeFilter}
                    availableTypes={availableTypes}
                    filtersActive={filtersActive}
                    onClear={clearFilters}
                    shownCount={filteredEntries.length}
                    totalCount={sortedEntries.length}
                  />
                )}
                <div className="ml-auto">
                  <Pager
                    currentPage={currentPage}
                    totalPages={totalPages}
                    hasPrev={currentPage > 1}
                    hasNext={Boolean(listQuery.data.next_token)}
                    isFetching={listQuery.isFetching}
                    walking={walking}
                    onPrev={prevPage}
                    onNext={nextPage}
                    onGoto={gotoPage}
                  />
                </div>
              </div>
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
                {filteredEntries.length === 0 ? (
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    {sortedEntries.length === 0
                      ? 'Empty directory.'
                      : 'No items match the current filter.'}
                  </div>
                ) : (
                  filteredEntries.map((entry) => (
                    <GalleryRow
                      key={entry.key}
                      entry={entry}
                      prefix={prefix}
                      storageName={storageName}
                      inBucketRoot={inBucketRoot}
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
                version={previewVersion}
              />
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {sortedEntries.length > 0 && (
                <FilterBar
                  nameValue={nameFilter}
                  onNameChange={setNameFilter}
                  typeValue={typeFilter}
                  onTypeChange={setTypeFilter}
                  availableTypes={availableTypes}
                  filtersActive={filtersActive}
                  onClear={clearFilters}
                  shownCount={filteredEntries.length}
                  totalCount={sortedEntries.length}
                />
              )}
              <div className="ml-auto">
                <Pager
                  currentPage={currentPage}
                  totalPages={totalPages}
                  hasPrev={currentPage > 1}
                  hasNext={Boolean(listQuery.data.next_token)}
                  isFetching={listQuery.isFetching}
                  walking={walking}
                  onPrev={prevPage}
                  onNext={nextPage}
                  onGoto={gotoPage}
                />
              </div>
            </div>

            {viewMode === 'grid' ? (
              <FileGrid
                entries={filteredEntries}
                prefix={prefix}
                storageName={storageName}
                inBucketRoot={inBucketRoot}
                fit={gridFit}
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
                  {filteredEntries.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="text-center text-muted-foreground py-10"
                      >
                        {sortedEntries.length === 0
                          ? 'Empty directory.'
                          : 'No items match the current filter.'}
                      </TableCell>
                    </TableRow>
                  )}
                  {filteredEntries.map((entry) => (
                    <FileRow
                      key={entry.key}
                      entry={entry}
                      prefix={prefix}
                      storageName={storageName}
                      inBucketRoot={inBucketRoot}
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
          version={previewVersion}
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
  /// True when the rendered listing is the root of an S3 multi-bucket
  /// storage — in that case every directory entry IS a bucket and gets
  /// the bucket visual instead of the folder one.
  inBucketRoot: boolean
  onSelect: (entry: FileEntry) => void
}

function FileRow({
  entry,
  prefix,
  storageName,
  inBucketRoot,
  onSelect,
}: FileRowProps) {
  const isBucket = entry.is_dir && inBucketRoot
  const dir = dirVisual(isBucket)
  const Icon = entry.is_dir ? dir.Icon : iconForKey(entry.key)
  const color = entry.is_dir ? dir.color : colorForKey(entry.key)
  const name = displayName(entry.key, prefix)
  const typeLabel = typeLabelForEntry(entry.key, entry.is_dir, isBucket)

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
  /// Extra utility classes — e.g. callers that need to hide the handle at
  /// certain breakpoints (`hidden md:block`).
  className?: string
}

// 4-px-wide column separator that captures pointer drags. `bg-border` matches
// the existing border-color used elsewhere; the hover/active states tint it
// with the primary color so the affordance is discoverable without being
// noisy at rest.
function ResizeHandle({ onPointerDown, className }: ResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className={cn(
        'group relative w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/40 active:bg-primary/60',
        className,
      )}
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
  /// See FileRowProps.inBucketRoot — same semantics.
  inBucketRoot: boolean
  selected: boolean
  onSelect: (entry: FileEntry) => void
}

function GalleryRow({
  entry,
  prefix,
  storageName,
  inBucketRoot,
  selected,
  onSelect,
}: GalleryRowProps) {
  const isBucket = entry.is_dir && inBucketRoot
  const dir = dirVisual(isBucket)
  const Icon = entry.is_dir ? dir.Icon : iconForKey(entry.key)
  const color = entry.is_dir ? dir.color : colorForKey(entry.key)
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
  /// See PreviewModal — same cache-busting role for the inline split view.
  version?: string | null
}

function InlinePreview({ fileKey, kind, storage, version }: InlinePreviewProps) {
  const src = proxyUrl(fileKey, storage, version)
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

interface FilterBarProps {
  nameValue: string
  onNameChange: (next: string) => void
  typeValue: string
  onTypeChange: (next: string) => void
  availableTypes: string[]
  filtersActive: boolean
  onClear: () => void
  shownCount: number
  totalCount: number
}

// Client-side filter controls for the current page. Pure UI — all filtering
// happens in the parent against the already-fetched listing, so changes are
// instant. The type select pulls from the page's actual types (not the
// whole VISUAL_GROUPS roster) so the user only sees options that resolve.
function FilterBar({
  nameValue,
  onNameChange,
  typeValue,
  onTypeChange,
  availableTypes,
  filtersActive,
  onClear,
  shownCount,
  totalCount,
}: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[180px] max-w-xs flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={nameValue}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Filter by name…"
          aria-label="Filter by name"
          className="h-8 pl-8"
        />
      </div>
      <select
        value={typeValue}
        onChange={(e) => onTypeChange(e.target.value)}
        aria-label="Filter by type"
        className="h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <option value="">All types</option>
        {availableTypes.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      {filtersActive && (
        <>
          <Button variant="ghost" size="sm" onClick={onClear} className="h-8">
            <X className="size-4" />
            Clear
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {shownCount} of {totalCount}
          </span>
        </>
      )}
    </div>
  )
}

interface PagerProps {
  currentPage: number
  /// Known total pages, or null when the backend didn't ship it and the
  /// frontend hasn't yet seen an EOF response. When present, renders as
  /// `Page X / Y`.
  totalPages: number | null
  hasPrev: boolean
  hasNext: boolean
  isFetching: boolean
  walking: boolean
  onPrev: () => void
  onNext: () => void
  onGoto: (page: number) => void
}

function Pager({
  currentPage,
  totalPages,
  hasPrev,
  hasNext,
  isFetching,
  walking,
  onPrev,
  onNext,
  onGoto,
}: PagerProps) {
  // Local string state so the user can type a multi-digit number without
  // each keystroke firing a navigation. Synced down from `currentPage`
  // whenever the actual page changes (Prev/Next/Goto/back-forward).
  const [input, setInput] = useState(String(currentPage))
  useEffect(() => {
    setInput(String(currentPage))
  }, [currentPage])

  if (!hasPrev && !hasNext && currentPage === 1) return null

  const busy = isFetching || walking
  const commit = () => {
    const n = Number(input)
    if (!Number.isFinite(n) || n < 1) {
      setInput(String(currentPage))
      return
    }
    let target = Math.floor(n)
    // When we know the total (local-fs has it on every response, S3 only
    // after we've seen an EOF), clamp client-side and tell the user so
    // their input isn't silently rewritten. The walk-EOF branch in
    // FileList covers the case where we don't know the total yet.
    if (totalPages !== null && target > totalPages) {
      toast.info(
        `Page ${target.toLocaleString()} doesn't exist — only ${totalPages.toLocaleString()} page${totalPages === 1 ? '' : 's'} available.`,
      )
      target = totalPages
    }
    if (target === currentPage) {
      setInput(String(currentPage))
      return
    }
    onGoto(target)
  }

  return (
    <div className="flex justify-end gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={!hasPrev || busy}
        onClick={onPrev}
      >
        <ChevronLeft className="size-4" />
        Prev
      </Button>
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Page</span>
        <Input
          type="number"
          min={1}
          max={totalPages ?? undefined}
          inputMode="numeric"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          // Enter commits; blur also commits so users who tab away aren't
          // surprised by a silently-discarded value.
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          onBlur={commit}
          disabled={busy}
          aria-label="Jump to page"
          className="h-8 w-16 text-center tabular-nums"
        />
        {totalPages !== null && (
          <span className="text-xs text-muted-foreground tabular-nums">
            / {totalPages.toLocaleString()}
          </span>
        )}
        {walking && (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={!hasNext || busy}
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

