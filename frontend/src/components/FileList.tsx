import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  PointerEvent as ReactPointerEvent,
  UIEvent as ReactUIEvent,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Navigate,
  useLocation,
  useNavigate,
  useNavigationType,
  useParams,
  useSearchParams,
} from 'react-router-dom'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Download,
  ExternalLink,
  FilePlus,
  FolderPlus,
  KeyRound,
  Loader2,
  LogOut,
  Ellipsis,
  PanelLeft,
  PanelLeftClose,
  RotateCw,
  Search,
  Share2,
  Upload,
  X,
} from 'lucide-react'

import { ApiError, getStoredToken, setStoredToken } from '@/api/client'
import { listFiles, proxyUrl, statFile } from '@/api/storage'
import {
  canShowInlinePreview,
  getBrowseScrollTarget,
  getFileListEmptyState,
  INLINE_PREVIEW_RESERVED_WIDTH,
  saveScrollPosition,
  type FileListEmptyState as EmptyStateKind,
} from '@/lib/file-list-ux'
import { basenameOf } from '@/lib/path'
import {
  getRovingKey,
  getRovingEntryAction,
  getRovingStep,
  getRovingTabStopKey,
  shouldEnterRovingRing,
  type RovingDirection,
} from '@/lib/roving-navigation'
import { isMultiBucketS3 } from '@/lib/storage-display'
import { resolveStorageUri } from '@/lib/resolve-uri'
import { encodePathSegments, getSidebarEntryRoute } from '@/lib/route-path'
import {
  useListFiles,
  usePrefetchListFiles,
  useServerInfo,
  useStorages,
} from '@/hooks/use-storage'
import {
  getKeyboardResizeWidth,
  useResizableWidth,
} from '@/hooks/use-resizable-width'
import { useSidebarCollapsed } from '@/hooks/use-sidebar-collapsed'
import { useSortDir, useSortField } from '@/hooks/use-sort-dir'
import { useGridFit } from '@/hooks/use-grid-fit'
import { useViewMode, type ViewMode } from '@/hooks/use-view-mode'
import { cn } from '@/lib/utils'
import { formatBytes, formatTime } from '@/lib/format'
import { sortEntriesBy } from '@/lib/sort'
import { BatchActionBar } from '@/components/BatchActionBar'
import { ShortcutHelpDialog } from '@/components/ShortcutHelpDialog'
import { EntryContextMenu } from '@/components/EntryContextMenu'
import { EntryIcon } from '@/components/EntryIcon'
import { NewFileDialog } from '@/components/NewFileDialog'
import { NewFolderDialog } from '@/components/NewFolderDialog'
import { UploadDialog } from '@/components/UploadDialog'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useGlobalShortcut } from '@/hooks/use-global-shortcut'
import { useRecents } from '@/hooks/use-recents'
import { useSelection } from '@/hooks/use-selection'
import { useCommandItems } from '@/hooks/use-command-items'
import { CommandPalette } from '@/components/CommandPalette'
import type { FileEntry, StorageEntryRef } from '@/types/storage'

const PREVIEW_PARAM = 'preview'
const PAGE_PARAM = 'page'
const VIEW_PARAM = 'view'
const REPO_URL = 'https://github.com/maoXyzt/omni-stream'

// Lazy-loaded so `marked` + `dompurify` stay out of the main bundle.
const ReadmePanel = lazy(() => import('./preview/ReadmePanel'))

function isValidViewMode(v: string | null): v is ViewMode {
  return v === 'list' || v === 'grid'
}

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
  const location = useLocation()
  const navigate = useNavigate()
  const navigationType = useNavigationType()
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
  // Proactive token entry. Reads stay public in the default gated mode, so a
  // user with no token never hits a read 401 — this lets them enter the token
  // up front (e.g. before running a write) instead of waiting to be prompted.
  const [showTokenPrompt, setShowTokenPrompt] = useState(false)
  // Toggles the "New file" creation dialog (only shown for writeable storages).
  const [showNewFile, setShowNewFile] = useState(false)
  // Toggles the "New folder" creation dialog (only shown for writeable storages).
  const [showNewFolder, setShowNewFolder] = useState(false)
  // Toggles the upload dialog (only shown for writeable storages).
  const [showUpload, setShowUpload] = useState(false)
  const activeStorage = useMemo(
    () => storagesQuery.data?.storages.find((s) => s.name === storageName),
    [storagesQuery.data, storageName],
  )
  // A storage opted into writes, with the server's write gate on. Gates the
  // "New file" entry point (and, downstream, the row context-menu actions).
  const canWrite = Boolean(
    storageName && activeStorage?.writeable && serverInfo.data?.write_enabled,
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
  const [storedViewMode, setStoredViewMode] = useViewMode()
  const urlViewParam = searchParams.get(VIEW_PARAM)
  // Ref keeps the latest urlViewParam without closing over it in callbacks,
  // so goToPath / goToPathOrFile / switchStorage don't rebuild on view toggle.
  const urlViewParamRef = useRef(urlViewParam)
  useEffect(() => {
    urlViewParamRef.current = urlViewParam
  }, [urlViewParam])
  const viewMode: ViewMode = isValidViewMode(urlViewParam) ? urlViewParam : storedViewMode
  const setViewMode = useCallback(
    (next: ViewMode) => {
      setStoredViewMode(next)
      setSearchParams(
        (prev) => {
          const nextParams = new URLSearchParams(prev)
          nextParams.set(VIEW_PARAM, next)
          return nextParams
        },
        { replace: true },
      )
    },
    [setStoredViewMode, setSearchParams],
  )
  // When a shared URL carries ?view=, sync that preference back to localStorage
  // so subsequent visits without the param remember the user's choice.
  useEffect(() => {
    if (isValidViewMode(urlViewParam) && urlViewParam !== storedViewMode) {
      setStoredViewMode(urlViewParam)
    }
  }, [urlViewParam, storedViewMode, setStoredViewMode])
  const [gridFit, setGridFit] = useGridFit()
  const [sortDir, setSortDir] = useSortDir()
  const [sortField, setSortField] = useSortField()
  const { record: recordRecent } = useRecents()
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
  const isAuthError =
    (listQuery.isError &&
      listQuery.error instanceof ApiError &&
      listQuery.error.status === 401) ||
    (storagesQuery.isError &&
      storagesQuery.error instanceof ApiError &&
      storagesQuery.error.status === 401)
  const mainRef = useRef<HTMLElement>(null)
  const [mainContentWidth, setMainContentWidth] = useState<number | null>(null)

  useLayoutEffect(() => {
    const main = mainRef.current
    if (!main) return

    const styles = window.getComputedStyle(main)
    const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0
    const paddingRight = Number.parseFloat(styles.paddingRight) || 0
    setMainContentWidth(
      main.clientWidth - paddingLeft - paddingRight,
    )

    const observer = new ResizeObserver(([entry]) => {
      setMainContentWidth(entry.contentRect.width)
    })
    observer.observe(main)
    return () => observer.disconnect()
  }, [isAuthError, storageName])

  // A directly-visited URL without a trailing slash is ambiguous —
  // `normalizePrefix` has already committed to listing it as a directory.
  // Let the listing outcome adjudicate:
  //  - non-empty → it IS a directory → replace-navigate to the canonical
  //    trailing-slash URL (search params preserved);
  //  - settled empty (or the backend errored — local fs rejects listing a
  //    file path, S3 just returns nothing) → stat the path once: a file
  //    redirects to its parent with the preview open (same end state as
  //    clicking it, mirroring goToPathOrFile), an empty-but-real directory
  //    just gets the canonical slash, and a failed stat leaves the page
  //    alone so the existing empty/error state stays visible.
  // `replace: true` everywhere keeps Back from bouncing through redirects;
  // `probedRef` caps the stat probe at one request per ambiguous path.
  const probedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!storageName || !rawSplat || rawSplat.endsWith('/')) return
    const canonical = () => {
      const qs = searchParams.toString()
      navigate(
        {
          pathname: `/s/${encodeURIComponent(storageName)}/${encodePathSegments(prefix)}`,
          search: qs ? `?${qs}` : '',
        },
        { replace: true },
      )
    }
    if (
      listQuery.data &&
      (listQuery.data.entries.length > 0 || listQuery.data.next_token)
    ) {
      canonical()
      return
    }
    // An auth failure is not evidence about the path — and probing through
    // it would permanently occupy probedRef, so the probe would never rerun
    // after the user supplies a token and the listing settles for real.
    const isAuthError =
      listQuery.isError &&
      listQuery.error instanceof ApiError &&
      listQuery.error.isUnauthorized
    const settledEmpty =
      (listQuery.isError && !isAuthError) ||
      (listQuery.data &&
        listQuery.data.entries.length === 0 &&
        !listQuery.data.next_token)
    if (!settledEmpty || currentPage !== 1) return
    const candidate = prefix.replace(/\/$/, '')
    if (!candidate || probedRef.current === candidate) return
    probedRef.current = candidate
    let cancelled = false
    statFile(candidate, storageName || undefined)
      .then((meta) => {
        if (cancelled) return
        if (meta.is_dir) {
          canonical()
          return
        }
        const slash = candidate.lastIndexOf('/')
        const parent = slash >= 0 ? candidate.slice(0, slash + 1) : ''
        const base = slash >= 0 ? candidate.slice(slash + 1) : candidate
        // Carry the visitor's query params along, minus the page cursor —
        // it indexed the bogus directory interpretation of the file path.
        const sp = new URLSearchParams(searchParams)
        sp.set(PREVIEW_PARAM, base)
        sp.delete(PAGE_PARAM)
        navigate(
          {
            pathname: `/s/${encodeURIComponent(storageName)}/${encodePathSegments(parent)}`,
            search: `?${sp.toString()}`,
          },
          { replace: true },
        )
      })
      .catch((err: unknown) => {
        // A 404 settles it — the path doesn't exist, keep the current view
        // for good. Anything else (network blip, 5xx, auth) is transient:
        // release the ref so the next listing settle can probe again.
        if (!(err instanceof ApiError && err.status === 404)) {
          probedRef.current = null
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    rawSplat,
    prefix,
    storageName,
    listQuery.data,
    listQuery.isError,
    listQuery.error,
    currentPage,
    searchParams,
    navigate,
  ])
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
            `Couldn't load page ${stuckPage.toLocaleString()} — the directory listing timed out. Try a smaller jump or open a narrower folder.`,
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
      const trail = clean ? encodePathSegments(clean) : ''
      navigate({
        pathname: `/s/${encodeURIComponent(storageName)}/${trail}`,
        search: isValidViewMode(urlViewParamRef.current)
          ? `?${VIEW_PARAM}=${urlViewParamRef.current}`
          : '',
      })
      // Record folder visit in recents — only settled navigations (not every
      // keystroke in PathNavigator). Root (empty prefix) is intentionally
      // included as a valid recent so users can jump back to a storage root.
      if (storageName) recordRecent(storageName, clean, 'folder')
    },
    [navigate, storageName, recordRecent],
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
  //
  // Returns `false` when the input couldn't be acted on and the user should
  // fix it in place (invalid/foreign URI, or a 401/403/5xx from stat), so
  // `PathNavigator` keeps its dialog open; `true` once we've navigated.
  const goToPathOrFile = useCallback(
    async (input: string): Promise<boolean> => {
      const resolved = resolveStorageUri(input, activeStorage)
      if (!resolved.ok) {
        toast.error(resolved.reason)
        return false
      }
      const trimmed = resolved.path.replace(/^\/+/, '')
      if (!trimmed || trimmed.endsWith('/')) {
        goToPath(trimmed)
        return true
      }
      let meta
      try {
        meta = await statFile(trimmed, storageName || undefined)
      } catch (err) {
        // A 404 (path doesn't exist) or a non-API error (network failure)
        // falls back to directory navigation, so the listing surfaces its
        // existing not-found/error state — the behavior before file paths were
        // supported. Other API errors (401/403/5xx) are reported directly:
        // falling back would misframe an auth/server problem as "directory not
        // found".
        if (err instanceof ApiError && err.status !== 404) {
          toast.error(`${err.status} — ${err.message}`)
          return false
        }
        goToPath(trimmed)
        return true
      }
      if (meta.is_dir) {
        goToPath(trimmed)
        return true
      }
      const slash = trimmed.lastIndexOf('/')
      const parent = slash >= 0 ? trimmed.slice(0, slash + 1) : ''
      const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
      const sp = new URLSearchParams()
      sp.set(PREVIEW_PARAM, base)
      if (isValidViewMode(urlViewParamRef.current)) {
        sp.set(VIEW_PARAM, urlViewParamRef.current)
      }
      setTokenStack([undefined])
      navigate({
        pathname: `/s/${encodeURIComponent(storageName)}/${encodePathSegments(parent)}`,
        search: `?${sp.toString()}`,
      })
      return true
    },
    [goToPath, navigate, storageName, activeStorage],
  )

  const goToSidebarEntry = useCallback(
    (entry: StorageEntryRef) => {
      const view = isValidViewMode(urlViewParamRef.current)
        ? urlViewParamRef.current
        : undefined
      const target = getSidebarEntryRoute(entry, view)

      setTokenStack([undefined])
      navigate({ pathname: target.pathname, search: target.search })
      recordRecent(entry.storage, target.cleanKey, entry.type)
    },
    [navigate, recordRecent],
  )

  const switchStorage = useCallback(
    (name: string) => {
      if (name === storageName) return
      setTokenStack([undefined])
      const vp = urlViewParamRef.current
      navigate({
        pathname: `/s/${encodeURIComponent(name)}/`,
        search: isValidViewMode(vp) ? `?${VIEW_PARAM}=${vp}` : '',
      })
      // Record the storage root as a folder visit.
      recordRecent(name, '', 'folder')
    },
    [navigate, storageName, recordRecent],
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
      // Record file visit in recents so the sidebar Recent section can surface it.
      if (storageName && !entry.is_dir) {
        recordRecent(storageName, entry.key, 'file')
      }
    },
    [prefix, setSearchParams, storageName, recordRecent],
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
    () =>
      listQuery.data
        ? sortEntriesBy(listQuery.data.entries, sortField, sortDir)
        : [],
    [listQuery.data, sortField, sortDir],
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
  const emptyState = getFileListEmptyState(
    sortedEntries.length,
    filteredEntries.length,
  )

  // ── Multi-select ──────────────────────────────────────────────────────────
  const selection = useSelection()

  const fileEntries = filteredEntries.filter((e) => !e.is_dir)
  const allChecked =
    fileEntries.length > 0 &&
    fileEntries.every((e) => selection.isSelected(e.key))
  const someChecked =
    !allChecked && fileEntries.some((e) => selection.isSelected(e.key))
  const headerChecked = allChecked
    ? true
    : someChecked
      ? 'indeterminate'
      : false

  // Clear the selection whenever the user navigates to a different directory,
  // switches storage, or flips to another page — selected keys from the old
  // page are meaningless in the new context.
  useEffect(() => {
    selection.clear()
    // `selection` itself is stable (referentially equal across renders), so
    // listing `selection.clear` avoids the exhaustive-deps warning without
    // pulling in the whole object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefix, storageName, currentPage])

  // Stable callback forwarded to FileRow/GalleryRow/FileGrid so memoized
  // tiles don't invalidate when the selection set changes.
  const handleSelectionToggle = useCallback(
    (entry: FileEntry, shiftKey: boolean) => {
      if (entry.is_dir) return
      if (shiftKey) {
        const orderedKeys = filteredEntries
          .filter((e) => !e.is_dir)
          .map((e) => e.key)
        selection.toggleRange(entry.key, orderedKeys)
      } else {
        selection.toggle(entry.key)
      }
    },
    // filteredEntries changes when filter/sort changes, which is intentional:
    // the shift-click range is always computed against the current visible set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredEntries, selection.toggle, selection.toggleRange],
  )

  const handleSelectAll = useCallback(() => {
    selection.selectAll(
      filteredEntries.filter((e) => !e.is_dir).map((e) => e.key),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredEntries, selection.selectAll])

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

  // ── README auto-detection ──────────────────────────────────────────────────
  // Fast path: scan the current page's entries (zero extra requests).
  const readmeFromPage = useMemo(() => {
    if (!listQuery.data) return null
    return (
      listQuery.data.entries.find(
        (e) => !e.is_dir && /^readme\.(md|markdown)$/i.test(basenameOf(e.key)),
      ) ?? null
    )
  }, [listQuery.data])

  // Slow path: when the directory spans multiple pages and README isn't on
  // the current page, probe via a single stat call so we still show it.
  // `isMultiPage` is true when more pages exist or we're already past page 1.
  const isMultiPage =
    Boolean(listQuery.data?.next_token) || currentPage > 1

  const readmeProbe = useQuery({
    queryKey: ['readme-probe', storageName, prefix],
    enabled: previewState === null && !readmeFromPage && isMultiPage && !showListSkeleton,
    retry: false,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<FileEntry | null> => {
      // Try the two most common README naming conventions in order. Using two
      // stat calls avoids enumerating all case variants while still covering
      // case-sensitive filesystems and S3 where `readme.md` is common.
      for (const name of ['README.md', 'readme.md']) {
        try {
          const meta = await statFile(prefix + name, storageName || undefined)
          if (meta.is_dir) continue
          return {
            key: meta.path,
            last_modified: meta.last_modified,
            is_dir: false,
            size: meta.size,
            is_symlink: false,
          }
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) continue
          // Any non-404 error (transient 5xx, auth, network) → give up silently.
          // A missing panel is better than a broken one.
          return null
        }
      }
      return null
    },
  })

  // The entry we'll pass to ReadmePanel — page hit wins over probe result.
  const readmeTarget = readmeFromPage ?? readmeProbe.data ?? null

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

  // Split layout = list view with enough room for both panes. Measuring the
  // main content box accounts for the resizable folder sidebar; viewport
  // breakpoints do not.
  const inlineListMaxWidth =
    mainContentWidth === null
      ? splitResize.maxWidth
      : Math.max(
          splitResize.minWidth,
          Math.min(
            splitResize.maxWidth,
            mainContentWidth - INLINE_PREVIEW_RESERVED_WIDTH,
          ),
        )
  const inlineListWidth = Math.min(splitResize.width, inlineListMaxWidth)
  const splitView =
    viewMode === 'list' &&
    previewState !== null &&
    canShowInlinePreview(mainContentWidth, splitResize.minWidth)

  // `?` help dialog state — mounted here so the shortcut is always active
  // while FileList is rendered.
  const [showHelp, setShowHelp] = useState(false)
  const [showCommandPalette, setShowCommandPalette] = useState(false)

  // ---------------------------------------------------------------------------
  // Global keyboard shortcuts (via the shared single-listener registry).
  // Previously four separate `window.addEventListener('keydown', …)` calls —
  // now consolidated to eliminate duplicated input-guard code and ensure there
  // is exactly one window listener for the whole app.
  // ---------------------------------------------------------------------------

  // `?` — open shortcut help (not '/' to avoid conflict with future search)
  useGlobalShortcut('?', () => setShowHelp((v) => !v))

  // Cmd+K — open command palette. `allowInEditable` so it works even when the
  // filter input or other text fields have focus (modifier combos don't
  // conflict with text entry).
  useGlobalShortcut(
    'mod+k',
    (e) => { e.preventDefault(); setShowCommandPalette((v) => !v) },
    { allowInEditable: true },
  )

  // Split-view arrow keys — navigate prev/next file. Active only while the
  // inline split preview is open (modal handles its own nav).
  useGlobalShortcut(
    'arrowdown',
    (e) => { e.preventDefault(); navigatePreview('next') },
    { active: splitView, includeMedia: true },
  )
  useGlobalShortcut(
    'arrowright',
    (e) => { e.preventDefault(); navigatePreview('next') },
    { active: splitView, includeMedia: true },
  )
  useGlobalShortcut(
    'arrowup',
    (e) => { e.preventDefault(); navigatePreview('prev') },
    { active: splitView, includeMedia: true },
  )
  useGlobalShortcut(
    'arrowleft',
    (e) => { e.preventDefault(); navigatePreview('prev') },
    { active: splitView, includeMedia: true },
  )

  // Esc — close split preview.
  useGlobalShortcut(
    'escape',
    (e) => { e.preventDefault(); closePreview() },
    { active: splitView },
  )

  // Backspace — go up one directory. No-op at storage root. Skipped when a
  // preview is open (Esc-to-close takes priority) or when modifier keys are
  // held (browser Back / Forward should work normally).
  useGlobalShortcut(
    'backspace',
    (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (previewState) return
      if (!parentInfo) return
      e.preventDefault()
      goToPath(parentInfo.parent)
    },
  )

  // Only the file viewport scrolls, so location and listing controls remain
  // available in both the regular and split layouts.
  const browseViewportRef = useRef<HTMLDivElement>(null)
  const directoryKey = `${storageName}\0${prefix}`
  const pageKey = `${directoryKey}\0${currentPage}`
  const previousBrowseStateRef = useRef({
    directoryKey,
    pageKey,
    splitView,
    locationKey: location.key,
  })
  const scrollPositionsRef = useRef(new Map<string, number>())
  const pendingScrollTopRef = useRef<number | null>(null)
  const [scrolled, setScrolled] = useState(false)

  useLayoutEffect(() => {
    const currentLocationKey = location.key
    const previous = previousBrowseStateRef.current
    const directoryChanged = previous.directoryKey !== directoryKey
    const pageChanged = previous.pageKey !== pageKey
    const splitViewChanged = previous.splitView !== splitView
    const container = browseViewportRef.current
    const scrollPositions = scrollPositionsRef.current
    const scrollTop = getBrowseScrollTarget({
      pageChanged,
      splitViewChanged,
      historyNavigation: navigationType === 'POP',
      savedScrollTop: scrollPositions.get(currentLocationKey),
      previousScrollTop: scrollPositions.get(previous.locationKey),
    })

    if (scrollTop === null) {
      if (container) {
        saveScrollPosition(
          scrollPositions,
          currentLocationKey,
          container.scrollTop,
        )
      }
    } else {
      pendingScrollTopRef.current = scrollTop
      if (container) container.scrollTop = scrollTop
      setScrolled(scrollTop > 100)
      if (directoryChanged) mainRef.current?.focus({ preventScroll: true })
    }
    previousBrowseStateRef.current = {
      directoryKey,
      pageKey,
      splitView,
      locationKey: currentLocationKey,
    }
  }, [directoryKey, location.key, navigationType, pageKey, splitView])

  useLayoutEffect(() => {
    if (showListSkeleton) return
    const scrollTop = pendingScrollTopRef.current
    const container = browseViewportRef.current
    if (scrollTop === null || !container) return
    container.scrollTop = scrollTop
    pendingScrollTopRef.current = null
  }, [pageKey, showListSkeleton, splitView])

  useLayoutEffect(() => {
    const container = mainRef.current
    if (!container) return
    const targetKey = getRovingTabStopKey(
      filteredEntries.map((entry) => entry.key),
      getRovingKey(document.activeElement),
    )
    container.querySelectorAll<HTMLElement>('[data-roving-key]').forEach((entry) => {
      entry.tabIndex = getRovingKey(entry) === targetKey ? 0 : -1
    })
  }, [filteredEntries, viewMode])

  const handleBrowseScroll = useCallback((event: ReactUIEvent<HTMLElement>) => {
    const { scrollTop } = event.currentTarget
    setScrolled(scrollTop > 100)
    saveScrollPosition(scrollPositionsRef.current, location.key, scrollTop)
  }, [location.key])
  const scrollToTop = useCallback(() => {
    pendingScrollTopRef.current = 0
    browseViewportRef.current?.scrollTo({
      top: 0,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    })
  }, [])

  // ---------------------------------------------------------------------------
  // Browsing-state arrow-key roving navigation (B3).
  //
  // Only active when previewState === null (pure browsing, no split or modal
  // preview). The split-view arrow handlers above guard on `splitView`, so the
  // two sets are mutually exclusive — no double-dispatch possible.
  //
  // Focus-driven, no state: current position is read from document.activeElement
  // via the `data-roving-key` attribute on tile buttons (grid) and table rows
  // (list). FileTile is React.memo'd — we never pass a `focused` prop; only a
  // stable `data-roving-key` derived from entry.key (memo-safe).
  // ---------------------------------------------------------------------------

  const moveRovingFocus = useCallback(
    (dir: RovingDirection): boolean => {
      const container = mainRef.current
      if (!container) return false

      const active = document.activeElement
      const curKey = getRovingKey(active)
      let idx = curKey
        ? filteredEntries.findIndex((e) => e.key === curKey)
        : -1

      if (idx === -1) {
        // Focus not on a roving entry. Only enter the roving ring when focus is
        // on the page body / nothing or already belongs to a roving entry, not
        // when it sits on a toolbar button, filter field, or other control.
        if (!shouldEnterRovingRing(active, document.body)) return false
        if (getRovingStep(viewMode, dir, 1) === null) return false
        idx = 0
      } else {
        // Grid: derive column count from the auto-fill computed style so the
        // up/down step is always exact even as the viewport resizes.
        const gridEl = container.querySelector('[data-roving-grid]')
        const cols = gridEl
          ? getComputedStyle(gridEl).gridTemplateColumns.trim().split(/\s+/).length
          : 1
        const step = getRovingStep(viewMode, dir, cols)
        if (step === null) return false
        idx = Math.max(0, Math.min(filteredEntries.length - 1, idx + step))
      }

      const target = filteredEntries[idx]
      if (!target) return false
      const el = container.querySelector(
        `[data-roving-key="${CSS.escape(target.key)}"]`,
      )
      if (!(el instanceof HTMLElement)) return false
      if (active instanceof HTMLElement && getRovingKey(active) !== null) {
        active.tabIndex = -1
      }
      el.tabIndex = 0
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: 'nearest' })
      return true
    },
    [filteredEntries, mainRef, viewMode],
  )

  const handleRovingShortcut = useCallback(
    (e: KeyboardEvent, dir: RovingDirection) => {
      if (moveRovingFocus(dir)) e.preventDefault()
    },
    [moveRovingFocus],
  )

  useGlobalShortcut(
    'arrowdown',
    (e) => handleRovingShortcut(e, 'down'),
    { active: previewState === null },
  )
  useGlobalShortcut(
    'arrowright',
    (e) => handleRovingShortcut(e, 'right'),
    { active: previewState === null },
  )
  useGlobalShortcut(
    'arrowup',
    (e) => handleRovingShortcut(e, 'up'),
    { active: previewState === null },
  )
  useGlobalShortcut(
    'arrowleft',
    (e) => handleRovingShortcut(e, 'left'),
    { active: previewState === null },
  )

  // Shared refresh callback — used by the toolbar button and the command palette.
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['list', storageName, prefix],
    })
  }, [queryClient, storageName, prefix])

  // Cross-storage jump — used by the command palette for recents/favorites that
  // may belong to a different storage. Same-storage folders go via goToPath;
  // cross-storage targets construct the full route URL.
  const jumpTo = useCallback(
    (storage: string, key: string, type: 'folder' | 'file') => {
      if (type === 'folder') {
        if (storage === storageName) {
          goToPath(key)
        } else {
          const trail = key ? encodePathSegments(key.endsWith('/') ? key : `${key}/`) : ''
          navigate({
            pathname: `/s/${encodeURIComponent(storage)}/${trail}`,
            search: isValidViewMode(urlViewParamRef.current)
              ? `?${VIEW_PARAM}=${urlViewParamRef.current}`
              : '',
          })
        }
      } else {
        // File: navigate to its parent directory with the preview param set.
        const slash = key.lastIndexOf('/')
        const parent = slash >= 0 ? key.slice(0, slash + 1) : ''
        const base = slash >= 0 ? key.slice(slash + 1) : key
        const sp = new URLSearchParams()
        sp.set(PREVIEW_PARAM, base)
        if (isValidViewMode(urlViewParamRef.current)) {
          sp.set(VIEW_PARAM, urlViewParamRef.current)
        }
        setTokenStack([undefined])
        navigate({
          pathname: `/s/${encodeURIComponent(storage)}/${encodePathSegments(parent)}`,
          search: `?${sp.toString()}`,
        })
      }
    },
    [storageName, goToPath, navigate],
  )

  // ── Command palette items ─────────────────────────────────────────────────
  const commandItems = useCommandItems({
    storageName,
    canWrite,
    viewMode,
    sortField,
    sortDir,
    // Use sortedEntries (not filteredEntries) so the palette's "On this page"
    // group searches across the full loaded page regardless of any active
    // name/type filter in FilterBar.
    entries: sortedEntries,
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
  })

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

  return (
    <div className="flex h-dvh w-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-background px-3 py-3 sm:px-6">
        <h1 className="min-w-0 text-2xl font-semibold">
          OmniStream
          {serverInfo.data?.hostname && (
            <span className="ml-2 hidden max-w-[40vw] truncate align-middle text-base font-normal text-muted-foreground md:inline-block">
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
                onNavigateEntry={goToSidebarEntry}
              />
            </aside>
            <ResizeHandle
              onPointerDown={sidebarResize.startResize}
              value={sidebarResize.width}
              min={sidebarResize.minWidth}
              max={sidebarResize.maxWidth}
              onResize={sidebarResize.resizeTo}
              ariaLabel="Resize folder sidebar"
              className="hidden md:block"
            />
          </>
        )}
        <main
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          className="flex w-full min-w-0 flex-col gap-4 overflow-hidden px-3 py-4 sm:px-6"
        >
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            Opened {prefix || '/'} in {storageName}
          </span>
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
              <PathNavigator prefix={prefix} activeStorage={activeStorage} onNavigate={goToPathOrFile} />
            </div>
            <div className="flex w-full shrink-0 flex-wrap items-center justify-between gap-2 lg:w-auto lg:justify-start">
              {/* Sort dropdown — field selector (name/size/mtime/type) and
                  direction toggle. The dropdown is compact so it doesn't
                  crowd the toolbar on narrow viewports. */}
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Sort by ${sortField}, ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
                        className="gap-1"
                      >
                        <ChevronsUpDown className="size-3.5 text-muted-foreground" />
                        <span className="hidden sm:inline text-xs capitalize">{sortField}</span>
                        {sortDir === 'asc' ? (
                          <ArrowDown className="size-3 text-muted-foreground" aria-hidden />
                        ) : (
                          <ArrowUp className="size-3 text-muted-foreground" aria-hidden />
                        )}
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>Sort listing</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuLabel className="text-xs">Sort by</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={sortField}
                    onValueChange={(v) => setSortField(v as typeof sortField)}
                  >
                    <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="size">Size</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="mtime">Modified</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="type">Type</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
                    className="gap-2"
                  >
                    {sortDir === 'asc' ? (
                      <ArrowDown className="size-3.5" />
                    ) : (
                      <ArrowUp className="size-3.5" />
                    )}
                    {sortDir === 'asc' ? 'Ascending' : 'Descending'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label="Refresh listing"
                    onClick={refresh}
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
              {canWrite && (
                <div className="hidden items-center gap-2 lg:flex">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label="New folder"
                        onClick={() => setShowNewFolder(true)}
                      >
                        <FolderPlus className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Create a new folder here</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label="New file"
                        onClick={() => setShowNewFile(true)}
                      >
                        <FilePlus className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Create a new file here</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label="Upload files"
                        onClick={() => setShowUpload(true)}
                      >
                        <Upload className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Upload files here</TooltipContent>
                  </Tooltip>
                </div>
              )}
              <ViewToggle mode={viewMode} onChange={setViewMode} />
              {viewMode === 'grid' && (
                <div className="hidden lg:block">
                  <GridFitToggle fit={gridFit} onChange={setGridFit} />
                </div>
              )}
              <div className="hidden items-center gap-2 lg:flex">
                <ShareLinkButton />
                {serverInfo.data?.auth_enabled && !hasToken && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label="Auth Token"
                        onClick={() => setShowTokenPrompt(true)}
                      >
                        <KeyRound className="size-4" />
                        Auth Token
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Enter the bearer token (needed for write operations, e.g. convert)
                    </TooltipContent>
                  </Tooltip>
                )}
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
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="lg:hidden"
                    aria-label="More actions"
                  >
                    <Ellipsis className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52 lg:hidden">
                  {canWrite && (
                    <>
                      <DropdownMenuItem onSelect={() => setShowNewFolder(true)}>
                        <FolderPlus className="size-4" />
                        New folder
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setShowNewFile(true)}>
                        <FilePlus className="size-4" />
                        New file
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setShowUpload(true)}>
                        <Upload className="size-4" />
                        Upload files
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  {viewMode === 'grid' && (
                    <>
                      <DropdownMenuLabel className="text-xs">
                        Thumbnail fit
                      </DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={gridFit}
                        onValueChange={(value) => setGridFit(value as typeof gridFit)}
                      >
                        <DropdownMenuRadioItem value="cover">
                          Fill thumbnails
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="contain">
                          Fit thumbnails
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <ShareLinkButton menuItem />
                  {serverInfo.data?.auth_enabled && !hasToken && (
                    <DropdownMenuItem onSelect={() => setShowTokenPrompt(true)}>
                      <KeyRound className="size-4" />
                      Auth token
                    </DropdownMenuItem>
                  )}
                  {hasToken && (
                    <DropdownMenuItem
                      onSelect={() => {
                        setStoredToken(null)
                        queryClient.invalidateQueries()
                      }}
                    >
                      <LogOut className="size-4" />
                      Sign out
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {showTokenPrompt && (
            <TokenPrompt
              onSubmit={() => {
                setShowTokenPrompt(false)
                queryClient.invalidateQueries()
              }}
              onCancel={() => setShowTokenPrompt(false)}
            />
          )}

          {showNewFolder && storageName && (
            <NewFolderDialog
              storage={storageName}
              prefix={prefix}
              onClose={() => setShowNewFolder(false)}
            />
          )}

          {showNewFile && storageName && (
            <NewFileDialog
              storage={storageName}
              prefix={prefix}
              onClose={() => setShowNewFile(false)}
            />
          )}

          {showUpload && storageName && (
            <UploadDialog
              storage={storageName}
              prefix={prefix}
              onClose={() => setShowUpload(false)}
            />
          )}

          <ShortcutHelpDialog
            open={showHelp}
            onClose={() => setShowHelp(false)}
          />

          <CommandPalette
            open={showCommandPalette}
            onClose={() => setShowCommandPalette(false)}
            items={commandItems}
          />

          {listQuery.isError && (
            <ErrorState
              error={listQuery.error}
              onRetry={() => void listQuery.refetch()}
              isRetrying={listQuery.isFetching}
            />
          )}

      {showListSkeleton ? (
        <div
          ref={browseViewportRef}
          onScroll={handleBrowseScroll}
          className="min-h-0 flex-1 overflow-auto"
        >
          {viewMode === 'grid' ? (
            <GridSkeleton />
          ) : splitView ? (
            <GallerySkeleton />
          ) : (
            <ListSkeleton />
          )}
        </div>
      ) : listQuery.data ? (
        splitView ? (
          <div className="flex min-h-0 flex-1">
            <div
              style={{ width: inlineListWidth }}
              className="flex shrink-0 flex-col gap-2 overflow-hidden pr-3"
            >
              {/* Batch action bar — appears above the filter/pager row when
                  one or more entries are selected. */}
              {selection.size > 0 && storageName && (
                <BatchActionBar
                  selectedKeys={selection.selectedKeys}
                  filteredEntries={filteredEntries}
                  storage={storageName}
                  prefix={prefix}
                  canWrite={canWrite}
                  onSelectAll={handleSelectAll}
                  onClear={selection.clear}
                />
              )}
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
                ref={browseViewportRef}
                onScroll={handleBrowseScroll}
                onClick={(e) => {
                  if (e.target === e.currentTarget) closePreview()
                }}
                className="flex min-h-0 flex-1 flex-col overflow-y-auto"
              >
                {filteredEntries.length === 0 ? (
                  <FileListEmptyState
                    state={emptyState}
                    canWrite={canWrite}
                    onClearFilters={clearFilters}
                    onNewFolder={() => setShowNewFolder(true)}
                    onUpload={() => setShowUpload(true)}
                  />
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
                      selectionChecked={selection.isSelected(entry.key)}
                      onSelectionToggle={handleSelectionToggle}
                    />
                  ))
                )}
              </div>
            </div>
            <ResizeHandle
              onPointerDown={(event) =>
                splitResize.startResize(event, inlineListMaxWidth)
              }
              value={inlineListWidth}
              min={splitResize.minWidth}
              max={inlineListMaxWidth}
              onResize={splitResize.resizeTo}
              ariaLabel="Resize file list"
            />
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
                  className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
                  title={previewState!.key}
                >
                  {previewState!.key}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Open in new tab"
                        onClick={() => {
                          window.open(
                            proxyUrl(previewState!.key, storageName || undefined),
                            '_blank',
                            'noreferrer',
                          )
                        }}
                      >
                        <ExternalLink className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Open in new tab</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <a
                        href={proxyUrl(previewState!.key, storageName || undefined)}
                        download={basenameOf(previewState!.key)}
                        className="inline-flex size-7 items-center justify-center rounded-[min(var(--radius-md),12px)] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label="Download"
                      >
                        <Download className="size-4" />
                      </a>
                    </TooltipTrigger>
                    <TooltipContent>Download</TooltipContent>
                  </Tooltip>
                </div>
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
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            {/* Batch action bar — appears above the filter/pager row. */}
            {selection.size > 0 && storageName && (
              <BatchActionBar
                selectedKeys={selection.selectedKeys}
                filteredEntries={filteredEntries}
                storage={storageName}
                prefix={prefix}
                canWrite={canWrite}
                onSelectAll={handleSelectAll}
                onClear={selection.clear}
              />
            )}
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

            <div
              ref={browseViewportRef}
              onScroll={handleBrowseScroll}
              className="min-h-0 flex-1 overflow-auto [&>[data-slot=table-container]]:overflow-visible"
            >
              {emptyState ? (
                <FileListEmptyState
                  state={emptyState}
                  canWrite={canWrite}
                  onClearFilters={clearFilters}
                  onNewFolder={() => setShowNewFolder(true)}
                  onUpload={() => setShowUpload(true)}
                />
              ) : viewMode === 'grid' ? (
                <FileGrid
                  entries={filteredEntries}
                  prefix={prefix}
                  storageName={storageName}
                  inBucketRoot={inBucketRoot}
                  fit={gridFit}
                  onSelect={handleEntry}
                  selectedKeys={selection.selectedKeys}
                  onSelectionToggle={handleSelectionToggle}
                />
              ) : (
                <Table aria-label="Files">
                  <TableHeader className="sticky top-0 z-10 bg-background shadow-[inset_0_-1px_0_var(--border)] [&_tr]:border-0">
                    <TableRow>
                      <TableHead className="w-8">
                        <Checkbox
                          checked={headerChecked}
                          aria-label="Select all files on this page"
                          disabled={fileEntries.length === 0}
                          onClick={(e) => e.stopPropagation()}
                          onCheckedChange={(checked) => {
                            if (checked) handleSelectAll()
                            else selection.clear()
                          }}
                        />
                      </TableHead>
                      <TableHead className="w-1/2">Name</TableHead>
                      <TableHead className="hidden w-28 lg:table-cell">Type</TableHead>
                      <TableHead className="hidden w-32 text-right lg:table-cell">Size</TableHead>
                      <TableHead className="hidden lg:table-cell">Modified</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredEntries.map((entry, index) => (
                      <FileRow
                        key={entry.key}
                        entry={entry}
                        prefix={prefix}
                        storageName={storageName}
                        inBucketRoot={inBucketRoot}
                        onSelect={handleEntry}
                        selectionChecked={selection.isSelected(entry.key)}
                        onSelectionToggle={handleSelectionToggle}
                        rovingTabIndex={index === 0 ? 0 : -1}
                      />
                    ))}
                  </TableBody>
                </Table>
              )}

              {/* README panel — shown when no file is open and the directory
                  contains a README.md (current page or detected via stat). */}
              {previewState === null && readmeTarget && (
                <Suspense fallback={null}>
                  <ReadmePanel
                    fileKey={readmeTarget.key}
                    storage={storageName || undefined}
                    version={readmeTarget.last_modified}
                    onViewSource={() => openPreview(readmeTarget)}
                  />
                </Suspense>
              )}
            </div>
          </div>
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

      {previewState && mainContentWidth !== null && !splitView && (
        <PreviewModal
          fileKey={previewState.key}
          kind={previewState.kind}
          storage={storageName || undefined}
          version={previewVersion}
          onClose={closePreview}
          onNavigate={navigatePreview}
          fallbackFocusRef={mainRef}
        />
      )}
    </div>
  )
}

function ShareLinkButton({ menuItem = false }: { menuItem?: boolean }) {
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
        if (menuItem) toast.success('Link copied')
        return
      }
    } catch {
      // fall through to prompt
    }
    window.prompt('Copy this link:', url)
  }

  if (menuItem) {
    return (
      <DropdownMenuItem onSelect={() => void onClick()}>
        <Share2 className="size-4" />
        Copy share link
      </DropdownMenuItem>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          onClick={onClick}
          aria-live="polite"
        >
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
  selectionChecked?: boolean
  onSelectionToggle?: (entry: FileEntry, shiftKey: boolean) => void
  rovingTabIndex: 0 | -1
}

function FileRow({
  entry,
  prefix,
  storageName,
  inBucketRoot,
  onSelect,
  selectionChecked,
  onSelectionToggle,
  rovingTabIndex,
}: FileRowProps) {
  const isBucket = entry.is_dir && inBucketRoot
  const dir = dirVisual(isBucket)
  const Icon = entry.is_dir ? dir.Icon : iconForKey(entry.key)
  const color = entry.is_dir ? dir.color : colorForKey(entry.key)
  const name = displayName(entry.key, prefix)
  const typeLabel = typeLabelForEntry(entry.key, entry.is_dir, isBucket)
  const selectable = !entry.is_dir && onSelectionToggle !== undefined

  return (
    <EntryContextMenu entry={entry} storageName={storageName}>
      <TableRow
        className="cursor-pointer hover:bg-muted/50"
        onClick={() => onSelect(entry)}
        // Roving navigation: make the row focusable and handle Enter so that
        // arrow-key focus works in list view. The <tr> is not a native button,
        // so Enter activation must be explicit. Only the first row joins the
        // natural Tab order; arrow keys move that single roving tab stop.
        tabIndex={rovingTabIndex}
        data-roving-key={entry.key}
        onKeyDown={(e) => {
          const action = getRovingEntryAction(
            e.key,
            e.target,
            e.currentTarget,
            selectable,
          )
          if (!action) return
          e.preventDefault()
          if (action === 'select') {
            onSelectionToggle?.(entry, e.shiftKey)
          } else {
            onSelect(entry)
          }
        }}
      >
        <TableCell
          onClick={(e) => {
            if (!selectable) return
            e.stopPropagation()
            onSelectionToggle(entry, e.shiftKey)
          }}
        >
          {selectable ? (
            <Checkbox
              checked={selectionChecked ?? false}
              aria-label={`Select ${name}`}
              tabIndex={-1}
            />
          ) : null}
        </TableCell>
        <TableCell className="flex items-center gap-2 truncate">
          <EntryIcon
            Icon={Icon}
            color={color}
            isSymlink={entry.is_symlink}
            className="size-4 shrink-0"
          />
          <span className="truncate" title={name}>
            {name}
          </span>
        </TableCell>
        <TableCell className="hidden text-muted-foreground lg:table-cell">
          {typeLabel}
        </TableCell>
        <TableCell className="hidden text-right tabular-nums text-muted-foreground lg:table-cell">
          {entry.is_dir ? '—' : formatBytes(entry.size)}
        </TableCell>
        <TableCell className="hidden text-muted-foreground lg:table-cell">
          {formatTime(entry.last_modified)}
        </TableCell>
      </TableRow>
    </EntryContextMenu>
  )
}

interface ResizeHandleProps {
  onPointerDown: (e: ReactPointerEvent) => void
  value: number
  min: number
  max: number
  onResize: (width: number) => void
  ariaLabel: string
  /// Extra utility classes — e.g. callers that need to hide the handle at
  /// certain breakpoints (`hidden md:block`).
  className?: string
}

// 4-px-wide column separator that captures pointer drags. `bg-border` matches
// the existing border-color used elsewhere; the hover/active states tint it
// with the primary color so the affordance is discoverable without being
// noisy at rest.
function ResizeHandle({
  onPointerDown,
  value,
  min,
  max,
  onResize,
  ariaLabel,
  className,
}: ResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        const next = getKeyboardResizeWidth(event.key, value, min, max)
        if (next === null) return
        event.preventDefault()
        onResize(next)
      }}
      className={cn(
        'group relative w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/40 active:bg-primary/60 focus-visible:bg-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {/* Invisible hit area centered over the visible bar so users don't need
          pixel-perfect aim; coarse pointers get the full 44-px target. */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 -left-1.5 w-4 pointer-coarse:-left-5 pointer-coarse:w-11"
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
  selectionChecked?: boolean
  onSelectionToggle?: (entry: FileEntry, shiftKey: boolean) => void
}

function GalleryRow({
  entry,
  prefix,
  storageName,
  inBucketRoot,
  selected,
  onSelect,
  selectionChecked,
  onSelectionToggle,
}: GalleryRowProps) {
  const isBucket = entry.is_dir && inBucketRoot
  const dir = dirVisual(isBucket)
  const Icon = entry.is_dir ? dir.Icon : iconForKey(entry.key)
  const color = entry.is_dir ? dir.color : colorForKey(entry.key)
  const name = displayName(entry.key, prefix)
  const ref = useRef<HTMLButtonElement>(null)
  const selectable = !entry.is_dir && onSelectionToggle !== undefined

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
      {/* Outer row: highlight covers the full row width (including checkbox slot)
          with a square edge, matching the FileRow/TableRow hover style. The
          `group` class lets child elements react to hover/focus-visible on the
          row via `group-hover:` and `group-has-[:focus-visible]:`. */}
      <div
        className={cn(
          'group flex items-center text-sm transition-colors',
          selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50',
        )}
      >
        {/* Fixed-width checkbox slot — always rendered (even for dirs) so that
            the icon column starts at the same left offset as in the full-width
            TableRow (w-8 slot + px-2 button padding = 40 px, matching
            TableHead w-8 + TableCell p-2). Coarse pointers reserve the full
            44 px checkbox target plus the leading 8 px. */}
        <div
          className="flex w-8 shrink-0 items-center pl-2 pointer-coarse:w-[52px]"
          onClick={(e) => {
            if (!selectable) return
            e.stopPropagation()
            onSelectionToggle(entry, e.shiftKey)
          }}
        >
          {selectable && (
            <Checkbox
              checked={selectionChecked ?? false}
              aria-label={`Select ${name}`}
              tabIndex={-1}
              className={cn(
                'transition-opacity duration-150',
                selectionChecked
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100',
              )}
            />
          )}
        </div>
        <button
          ref={ref}
          type="button"
          onClick={() => onSelect(entry)}
          onKeyDown={(e) => {
            if (
              getRovingEntryAction(
                e.key,
                e.target,
                e.currentTarget,
                selectable,
              ) !== 'select'
            ) {
              return
            }
            e.preventDefault()
            onSelectionToggle?.(entry, e.shiftKey)
          }}
          title={name}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
        >
          <EntryIcon
            Icon={Icon}
            color={color}
            isSymlink={entry.is_symlink}
            className="size-4 shrink-0"
          />
          <span className="truncate">{name}</span>
        </button>
      </div>
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
    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <div className="relative min-w-0 flex-1 sm:min-w-[180px] sm:max-w-xs">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={nameValue}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Filter this page by name…"
          aria-label="Filter this page by name"
          className="pl-8"
        />
      </div>
      <select
        value={typeValue}
        onChange={(e) => onTypeChange(e.target.value)}
        aria-label="Filter this page by type"
        className="h-8 rounded-md border border-input bg-background px-2 text-sm pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px] focus:outline-none focus:ring-2 focus:ring-ring"
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
          <Button variant="ghost" size="sm" onClick={onClear}>
            <X className="size-4" />
            Clear
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {shownCount} of {totalCount} on this page
          </span>
        </>
      )}
    </div>
  )
}

interface FileListEmptyStateProps {
  state: EmptyStateKind
  canWrite: boolean
  onClearFilters: () => void
  onNewFolder: () => void
  onUpload: () => void
}

function FileListEmptyState({
  state,
  canWrite,
  onClearFilters,
  onNewFolder,
  onUpload,
}: FileListEmptyStateProps) {
  const noMatches = state === 'no-matches'

  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      {noMatches ? (
        <Search className="size-8 text-muted-foreground" aria-hidden />
      ) : (
        <FolderPlus className="size-8 text-muted-foreground" aria-hidden />
      )}
      <p
        className="text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        {noMatches
          ? 'No items match filters on this page.'
          : 'This directory is empty.'}
      </p>
      {noMatches ? (
        <Button variant="outline" size="sm" onClick={onClearFilters}>
          <X className="size-4" />
          Clear filters
        </Button>
      ) : canWrite ? (
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="outline" size="sm" onClick={onNewFolder}>
            <FolderPlus className="size-4" />
            New folder
          </Button>
          <Button size="sm" onClick={onUpload}>
            <Upload className="size-4" />
            Upload files
          </Button>
        </div>
      ) : null}
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
  const [pendingAction, setPendingAction] = useState<
    'prev' | 'next' | 'goto' | null
  >(null)
  useEffect(() => {
    setInput(String(currentPage))
  }, [currentPage])
  const busy = isFetching || walking
  useEffect(() => {
    if (!busy) setPendingAction(null)
  }, [busy])

  if (!hasPrev && !hasNext && currentPage === 1) return null

  const prevBusy = busy && pendingAction === 'prev'
  const nextBusy = busy && pendingAction === 'next'
  const centerBusy = busy && !prevBusy && !nextBusy
  const loadingMessage = prevBusy
    ? 'Loading previous page'
    : nextBusy
      ? 'Loading next page'
      : centerBusy
        ? 'Loading page'
        : ''
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
    setPendingAction('goto')
    onGoto(target)
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="sr-only" role="status" aria-live="polite">
        {loadingMessage}
      </span>
      <Button
        variant="outline"
        size="sm"
        aria-label={prevBusy ? loadingMessage : 'Previous page'}
        aria-busy={prevBusy || undefined}
        disabled={!hasPrev || busy}
        onClick={() => {
          setPendingAction('prev')
          onPrev()
        }}
      >
        {prevBusy ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <ChevronLeft className="size-4" />
        )}
        <span className={cn(!prevBusy && 'hidden sm:inline')}>
          {prevBusy ? 'Loading…' : 'Prev'}
        </span>
      </Button>
      <div className="flex items-center gap-1.5">
        <span className="hidden text-xs text-muted-foreground sm:inline">Page</span>
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
          <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
            / {totalPages.toLocaleString()}
          </span>
        )}
        {centerBusy && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            <span>Loading…</span>
          </span>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        aria-label={nextBusy ? loadingMessage : 'Next page'}
        aria-busy={nextBusy || undefined}
        disabled={!hasNext || busy}
        onClick={() => {
          setPendingAction('next')
          onNext()
        }}
      >
        <span className={cn(!nextBusy && 'hidden sm:inline')}>
          {nextBusy ? 'Loading…' : 'Next'}
        </span>
        {nextBusy ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-4" />
        )}
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
