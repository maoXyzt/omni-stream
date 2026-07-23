import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useBeforeUnload,
  useBlocker,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertCircle,
  ArrowDown,
  BookText,
  Check,
  ChevronDown,
  ChevronUp,
  Code,
  Copy,
  Download,
  FileDown,
  LayoutList,
  ListOrdered,
  Loader2,
  Pencil,
  RotateCw,
  Save,
  Search,
  X,
} from 'lucide-react'

import { Editor } from '@/lib/code-editor'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ApiError } from '@/api/client'
import { getConvertStatus, startConvert } from '@/api/convert'
import { putFile } from '@/api/files'
import { extractErrorDetail, type ErrorDetail } from '@/lib/api-error'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { TokenPrompt } from '@/components/TokenPrompt'
import { useGlobalShortcut } from '@/hooks/use-global-shortcut'
import { useLineNumbers } from '@/hooks/use-line-numbers'
import { useRowsViewHint } from '@/hooks/use-rows-view-hint'
import { useServerInfo, useStorages } from '@/hooks/use-storage'
import {
  SUPPORTED_LANGUAGES,
  detectLanguage,
  ensureLanguage,
  highlight,
  isLanguageBundled,
} from '@/lib/highlight'
import { extensionOf } from '@/lib/path'
import { detectFormat } from '@/lib/rows-source'
import {
  CHUNK_BYTES,
  INITIAL_STATE,
  type LoadState,
  describeFetchError,
  fetchRange,
  formatBytes,
  mergeChunk,
  splitLines,
} from '@/lib/text-chunks'
import { cn } from '@/lib/utils'

import { RowsViewHint } from './RowsViewHint'
import type { PreviewerProps } from './types'

// Lazy-loaded so Vite keeps `marked` + `dompurify` out of the main bundle.
const MarkdownProse = lazy(() => import('./MarkdownProse'))

// Query param key that the Rows view writes its rule config into. Forwarded
// when the user jumps from text preview to the Rows page so a shared link
// with rules pre-applied still works.
const ROWS_PARAM = 'rows'

// "Load all" severity tiers — chosen against *remaining* bytes (what the
// user still has to fetch), not file size. Per-line syntax highlighting is
// the dominant cost above ~5 MiB; beyond ~20 MiB Chrome will visibly stall
// or OOM, so the heavy tier intentionally reads as "are you sure".
const LOAD_ALL_WARN_BYTES = 5 * 1024 * 1024
const LOAD_ALL_HEAVY_BYTES = 20 * 1024 * 1024

// Editor-usability cap, intentionally far below the backend's 16 MiB
// MAX_PUT_BYTES (which is the hard save limit). react-simple-code-editor
// re-highlights and re-renders the entire document on every keystroke, so
// multi-MiB files make typing janky; 2 MiB keeps inline editing responsive.
// Above this the Edit button is disabled (the file can still be downloaded).
const MAX_EDIT_BYTES = 2 * 1024 * 1024

type LoadAllSeverity = 'light' | 'warn' | 'heavy'

function loadAllSeverityFor(remainingBytes: number | null): LoadAllSeverity {
  // Unknown total → warn (we have no idea how much we'd actually pull).
  if (remainingBytes === null) return 'warn'
  if (remainingBytes >= LOAD_ALL_HEAVY_BYTES) return 'heavy'
  if (remainingBytes >= LOAD_ALL_WARN_BYTES) return 'warn'
  return 'light'
}

interface MatchRange { line: number; start: number; end: number }

function renderLineWithMarks(
  raw: string,
  ranges: MatchRange[],
  activeIdx: number,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let pos = 0
  for (let ri = 0; ri < ranges.length; ri++) {
    const { start, end } = ranges[ri]
    if (start > pos) nodes.push(raw.slice(pos, start))
    nodes.push(
      <mark
        key={ri}
        className={
          ri === activeIdx
            ? 'rounded bg-amber-400 ring-1 ring-amber-500'
            : 'rounded bg-amber-200 dark:bg-amber-800'
        }
      >
        {raw.slice(start, end)}
      </mark>,
    )
    pos = end
  }
  if (pos < raw.length) nodes.push(raw.slice(pos))
  return nodes
}

export function TextPreview({ fileKey, src, storage }: PreviewerProps) {
  const navigate = useNavigate()
  const { hash } = useLocation()
  const [searchParams] = useSearchParams()

  // True for .md / .markdown — these get a Raw/Rendered toggle defaulting to
  // the rendered view. .rst is excluded: marked doesn't parse reStructuredText
  // so rendering would just emit the source verbatim with no benefit.
  const isMarkdown = useMemo(() => {
    const ext = extensionOf(fileKey)
    return ext === 'md' || ext === 'markdown'
  }, [fileKey])

  // Per-file view preference — no localStorage persistence since the component
  // remounts per file anyway and the default (Rendered for .md) is the right
  // starting point each time.
  const [view, setView] = useState<'rendered' | 'raw'>(() =>
    isMarkdown ? 'rendered' : 'raw',
  )

  // If `fileKey` changes (same component reused across files), re-derive the
  // default view rather than carrying over the previous file's preference.
  useEffect(() => {
    setView(isMarkdown ? 'rendered' : 'raw')
  }, [fileKey, isMarkdown])

  // .jsonl / .ndjson get a "Browse as cards" button that jumps to the Rows
  // page — same UX as parquet's ParquetPreview but lazy: text-preview-able
  // formats default to the text view, this is the opt-in.
  const rowsFormat = useMemo(() => detectFormat(fileKey), [fileKey])
  const openRowsPage = useCallback(() => {
    if (!storage || !rowsFormat) return
    const rules = searchParams.get(ROWS_PARAM)
    const trail = fileKey
      .split('/')
      .filter((s) => s.length > 0)
      .map(encodeURIComponent)
      .join('/')
    const query = rules ? `?${ROWS_PARAM}=${encodeURIComponent(rules)}` : ''
    navigate(`/r/${encodeURIComponent(storage)}/${trail}${query}`)
  }, [storage, rowsFormat, searchParams, fileKey, navigate])
  // --- Convert to Parquet ---------------------------------------------------

  const queryClient = useQueryClient()
  const serverInfo = useServerInfo()
  // Show the button for JSONL/NDJSON and TSV/CSV when the DuckDB-backed
  // convert endpoint is live (sql_enabled implies auth + [sql] + duckdb build).
  const canConvert =
    (rowsFormat === 'jsonl' || rowsFormat === 'csv') &&
    Boolean(serverInfo.data?.sql_enabled) &&
    Boolean(storage)

  // Button label reflects the source format so the conversion direction is clear.
  const convertLabel = useMemo(() => {
    if (rowsFormat === 'jsonl') return 'JSONL → Parquet'
    const ext = fileKey.split('.').pop()?.toUpperCase() ?? 'CSV'
    return `${ext} → Parquet`
  }, [rowsFormat, fileKey])
  const [converting, setConverting] = useState(false)
  // Non-null while a background conversion job is tracked (progress dialog open).
  const [convertJobId, setConvertJobId] = useState<string | null>(null)
  const [showOverwriteDialog, setShowOverwriteDialog] = useState(false)
  // Non-null while a "Conversion failed" dialog is open.
  const [convertError, setConvertError] = useState<ErrorDetail | null>(null)
  const [convertErrRawCopied, setConvertErrRawCopied] = useState(false)
  const convertErrCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (convertErrCopyTimeoutRef.current) clearTimeout(convertErrCopyTimeoutRef.current)
    },
    [],
  )
  // Non-null while a convert was rejected with 401 (write needs a token in the
  // default gated mode). Holds the `overwrite` flag so the retry after the
  // token is entered preserves the user's intent.
  const [convertAuthOverwrite, setConvertAuthOverwrite] = useState<
    boolean | null
  >(null)
  // Output filename derived from the input key (shown in the overwrite dialog).
  const outputKey = useMemo(() => {
    const dot = fileKey.lastIndexOf('.')
    return dot >= 0 ? `${fileKey.slice(0, dot)}.parquet` : `${fileKey}.parquet`
  }, [fileKey])

  const handleConvert = useCallback(
    async (overwrite = false) => {
      if (!storage) return
      setConverting(true)
      try {
        // POST returns immediately (202) with a job_id. Synchronous errors
        // (401, 409, 400) are still thrown here so existing branches work.
        const { job_id } = await startConvert(storage, fileKey, overwrite)
        // Open the progress dialog; polling is handled by ConvertProgressDialog.
        setConvertJobId(job_id)
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setConvertAuthOverwrite(overwrite)
        } else if (err instanceof ApiError && err.status === 409) {
          setShowOverwriteDialog(true)
        } else if (err instanceof ApiError) {
          // Show a rich dialog with the server's classified summary, hint,
          // and the raw DuckDB error so the user can diagnose the failure.
          setConvertError(extractErrorDetail(err))
        } else {
          toast.error(String(err))
        }
      } finally {
        setConverting(false)
      }
    },
    [storage, fileKey],
  )

  // Gate the hint banner wrapper so dismissing it doesn't leave a phantom
  // padding strip — RowsViewHint itself returns null when dismissed, but
  // the surrounding spacing div would still take space without this check.
  const { dismissed: rowsHintDismissed } = useRowsViewHint()
  const showRowsHint = Boolean(rowsFormat) && !rowsHintDismissed

  // --- Chunked fetch -----------------------------------------------------

  // useInfiniteQuery handles cancellation, dedupe, and per-file caching for
  // free; queryKey on src isolates state by storage+path. Each page is one
  // CHUNK_BYTES-sized Range request; the next page starts where the last
  // ended. getNextPageParam returns undefined once the server reports EOF,
  // which is what hides the "Load more" button (hasNextPage === false).
  const textQuery = useInfiniteQuery({
    queryKey: ['text-preview', src] as const,
    queryFn: ({ pageParam }) =>
      fetchRange(src, pageParam, pageParam + CHUNK_BYTES - 1),
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.isFull ? undefined : lastPage.endByte + 1,
    staleTime: Infinity,
  })

  // Accumulated state derived from the loaded pages. Same shape as the
  // previous local LoadState so downstream rendering doesn't change.
  const state = useMemo<LoadState>(() => {
    const pages = textQuery.data?.pages ?? []
    return pages.reduce(mergeChunk, INITIAL_STATE)
  }, [textQuery.data])

  const loading = textQuery.isFetching
  const loadingNext = textQuery.isFetchingNextPage
  const firstLoading = textQuery.isPending && textQuery.isFetching
  const errorMessage = textQuery.error ? describeFetchError(textQuery.error) : null

  // --- Language selection (highlighting) ---------------------------------

  // Initial language from the file extension; the dropdown can override.
  const initialLang = useMemo(() => detectLanguage(fileKey), [fileKey])
  const [lang, setLang] = useState(initialLang)
  const [ready, setReady] = useState(
    () => isLanguageBundled(initialLang) || initialLang === 'plaintext',
  )

  // Reset to the extension-derived language when the file changes. If the
  // modal remounts per file (the common case) this is a no-op on mount; if
  // the component is reused across files we still want a sensible default.
  useEffect(() => {
    setLang(initialLang)
  }, [initialLang])

  // Load the grammar if it isn't bundled. `cancelled` guards against races
  // when the user rapid-flips the dropdown.
  useEffect(() => {
    if (lang === 'plaintext' || isLanguageBundled(lang)) {
      setReady(true)
      return
    }
    setReady(false)
    let cancelled = false
    ensureLanguage(lang).then(() => {
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [lang])

  // --- Per-line rendering ------------------------------------------------

  const lines = useMemo(() => {
    const all = splitLines(state.text)
    // While more bytes are pending, the trailing line — if the buffer doesn't
    // end on a newline — is a partial: bytes mid-line, often mid-token. Hide
    // it; the next chunk will complete and reveal it.
    if (!state.done && !state.text.endsWith('\n') && all.length > 0) {
      all.pop()
    }
    return all
  }, [state.text, state.done])

  // Per-line highlighting instead of "highlight whole, split HTML on `\n`":
  // the whole-buffer trick produces broken HTML whenever a token straddles a
  // newline, which is common in real code (Python docstrings, JS template
  // literals, C block comments). Cost: N highlight() calls per file —
  // acceptable up to a few thousand lines; very large files can be flipped
  // to plaintext via the dropdown if highlighting becomes a hotspot.
  const highlightedLines = useMemo<string[] | null>(() => {
    if (!ready || lines.length === 0 || lang === 'plaintext') return null
    return lines.map((line) => highlight(line, lang))
  }, [lines, lang, ready])

  // Lock the gutter to digit width so the content column doesn't jitter as
  // the count crosses 10 / 100 / 1000.
  const gutterChars = Math.max(2, String(lines.length).length)

  const statusLine = (() => {
    const bytes = `${formatBytes(state.bytesLoaded)} / ${formatBytes(state.totalBytes)}`
    const lineLabel = `${lines.length} line${lines.length === 1 ? '' : 's'}`
    return `${lineLabel} · ${bytes}`
  })()

  // Surface "not fully loaded" as a coloured badge in the header rather than
  // relying on the absence of a muted "· EOF" suffix — the old hint was easy
  // to miss, so users would copy/scroll a partially-loaded buffer thinking it
  // was the whole file.
  const isPartial = !state.done && state.text.length > 0
  const progressPercent =
    state.totalBytes !== null && state.totalBytes > 0
      ? Math.min(100, Math.round((state.bytesLoaded / state.totalBytes) * 100))
      : null
  const remainingBytes =
    state.totalBytes !== null
      ? Math.max(0, state.totalBytes - state.bytesLoaded)
      : null
  const loadAllSeverity = loadAllSeverityFor(remainingBytes)

  // --- Load all ---------------------------------------------------------

  const [loadAllOpen, setLoadAllOpen] = useState(false)
  const [loadingAll, setLoadingAll] = useState(false)
  // Cancellation flag for the load-all loop. We can't abort the in-flight
  // chunk (axios `get` here doesn't carry a signal), but flipping this stops
  // the next iteration — usually the user wants "stop after this MiB".
  const cancelLoadAllRef = useRef(false)
  useEffect(
    () => () => {
      cancelLoadAllRef.current = true
    },
    [],
  )

  const startLoadAll = useCallback(async () => {
    setLoadAllOpen(false)
    cancelLoadAllRef.current = false
    setLoadingAll(true)
    try {
      // Each fetchNextPage resolves to an observer result whose `hasNextPage`
      // reflects post-merge state, so we don't read stale `textQuery` props.
      let result = await textQuery.fetchNextPage()
      while (
        !cancelLoadAllRef.current &&
        result.hasNextPage &&
        !result.isError
      ) {
        result = await textQuery.fetchNextPage()
      }
    } finally {
      setLoadingAll(false)
    }
  }, [textQuery])

  const cancelLoadAll = useCallback(() => {
    cancelLoadAllRef.current = true
  }, [])

  // Persistent UI preference — the gutter is on by default (matches every
  // editor), and the toggle survives modal close + reload via localStorage.
  const [showLineNumbers, setShowLineNumbers] = useLineNumbers()

  // --- Find bar (Cmd+F) ---------------------------------------------------

  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const findInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Highlighted line from #L<n> hash deep-link.
  const [deepLine, setDeepLine] = useState<number | null>(null)
  const lastScrolledHashRef = useRef<string | null>(null)

  const matches = useMemo<MatchRange[]>(() => {
    if (!findQuery) return []
    const lower = findQuery.toLowerCase()
    const result: MatchRange[] = []
    for (let i = 0; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase()
      let pos = 0
      while (true) {
        const idx = lineLower.indexOf(lower, pos)
        if (idx === -1) break
        result.push({ line: i, start: idx, end: idx + lower.length })
        pos = idx + lower.length
      }
    }
    return result
  }, [lines, findQuery])

  // Pre-bucket matches by line so the render loop can do O(1) lookups instead
  // of O(M) filter + indexOf per line (avoids O(N×M) total complexity).
  const matchesByLine = useMemo(() => {
    const buckets: Array<{ ranges: MatchRange[]; activeIdx: number }> = Array.from(
      { length: lines.length },
      () => ({ ranges: [], activeIdx: -1 }),
    )
    for (let gi = 0; gi < matches.length; gi++) {
      const m = matches[gi]
      const bucket = buckets[m.line]
      if (!bucket) continue
      if (gi === activeMatch) bucket.activeIdx = bucket.ranges.length
      bucket.ranges.push(m)
    }
    return buckets
  }, [lines.length, matches, activeMatch])

  // Clamp activeMatch when match count changes (via effect, not render phase).
  useEffect(() => {
    if (matches.length === 0) {
      setActiveMatch(0)
    } else {
      setActiveMatch((prev) => Math.min(prev, matches.length - 1))
    }
  }, [matches.length])

  // Scroll to the active match.
  useEffect(() => {
    if (matches.length === 0 || !scrollRef.current) return
    const m = matches[activeMatch]
    if (!m) return
    scrollRef.current
      .querySelector(`[data-line="${m.line + 1}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeMatch, matches])

  // Hash deep-link: #L<n> → scroll and highlight target line.
  // lastScrolledHashRef prevents re-scrolling every time a new chunk loads
  // (lines.length changes) after the target line is already visible.
  useEffect(() => {
    const match = /^#L(\d+)$/.exec(hash)
    if (!match) {
      lastScrolledHashRef.current = null
      return
    }
    if (lastScrolledHashRef.current === hash) return
    const n = parseInt(match[1], 10)
    if (n < 1 || n > lines.length) return
    lastScrolledHashRef.current = hash
    scrollRef.current
      ?.querySelector(`[data-line="${n}"]`)
      ?.scrollIntoView({ block: 'center' })
    setDeepLine(n)
    const timer = setTimeout(() => setDeepLine(null), 2000)
    return () => clearTimeout(timer)
  }, [hash, lines.length])

  // Copy the lines currently visible (excludes the trailing partial line while
  // more bytes are pending — see `lines` memo above).
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    },
    [],
  )
  const handleCopy = useCallback(async () => {
    if (lines.length === 0) return
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can fail under insecure contexts or denied permissions; a
      // silent no-op is fine here — the tooltip stays in its default state.
    }
  }, [lines])

  // One spinner covers both in-flight fetches and grammar loads — both mean
  // "wait a moment".
  const showSpinner = loading || (!ready && lang !== 'plaintext')

  // --- Inline editing ----------------------------------------------------

  // Editing needs a writeable storage and the server's write gate on. The
  // token itself is checked lazily at save time (401 → TokenPrompt → retry),
  // matching the convert flow — so the Edit button shows even before sign-in.
  const storages = useStorages()
  const descriptor = storages.data?.storages.find((s) => s.name === storage)
  // Warn when the storage is S3 and httpfs is confirmed unavailable — local
  // storages don't use httpfs, so the flag is suppressed for them. Only shown
  // when canConvert is true (the convert button is visible).
  const showHttpfsWarning =
    canConvert &&
    descriptor?.type === 's3' &&
    serverInfo.data?.httpfs_ready === false
  const canWrite = Boolean(
    storage && descriptor?.writeable && serverInfo.data?.write_enabled,
  )
  // Files past the write cap can't be saved (the PUT would 413), so offer no
  // edit affordance for them.
  const tooLargeToEdit =
    state.totalBytes !== null && state.totalBytes > MAX_EDIT_BYTES

  const [editing, setEditing] = useState(false)

  // Find bar is only usable in raw/code mode with content loaded.
  const findEnabled = !editing && (!isMarkdown || view === 'raw') && lines.length > 0

  // Close find bar automatically when leaving the mode that renders it.
  useEffect(() => {
    if (!findEnabled) setFindOpen(false)
  }, [findEnabled])

  // Cmd+F opens the find bar (also works when find input already has focus).
  // Gated so edit-mode and Markdown-rendered-mode don't block browser native find.
  useGlobalShortcut(
    'mod+f',
    (e) => {
      e.preventDefault()
      setFindOpen(true)
      requestAnimationFrame(() => findInputRef.current?.select())
    },
    { active: findEnabled, allowInEditable: true },
  )

  const [draft, setDraft] = useState('')
  // Set when Edit is clicked on a not-yet-fully-loaded file: a load-all runs
  // and the effect below enters edit mode once the whole file is in memory.
  // Editing a partial buffer would truncate the file on save.
  const [wantEdit, setWantEdit] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmSave, setConfirmSave] = useState(false)
  const [discardConfirm, setDiscardConfirm] = useState(false)
  // True while a save was rejected with 401 and the token prompt is showing.
  const [saveAuth, setSaveAuth] = useState(false)

  const dirty = editing && draft !== state.text
  const navigationBlocker = useBlocker(dirty)
  const handleBeforeUnload = useCallback(
    (event: BeforeUnloadEvent) => {
      if (!dirty) return
      event.preventDefault()
      event.returnValue = ''
    },
    [dirty],
  )
  useBeforeUnload(handleBeforeUnload)

  const enterEdit = useCallback(() => {
    if (tooLargeToEdit) return
    if (state.done) {
      setDraft(state.text)
      setEditing(true)
    } else {
      setWantEdit(true)
      void startLoadAll()
    }
  }, [tooLargeToEdit, state.done, state.text, startLoadAll])

  // Enter edit mode once a requested load-all has pulled the whole file.
  useEffect(() => {
    if (wantEdit && state.done) {
      setDraft(state.text)
      setEditing(true)
      setWantEdit(false)
    }
  }, [wantEdit, state.done, state.text])

  const doSave = useCallback(async () => {
    if (!storage) return
    setSaving(true)
    try {
      await putFile(storage, fileKey, draft, true)
      toast.success(`Saved ${fileKey}`)
      if (navigationBlocker.state === 'blocked') navigationBlocker.reset()
      setConfirmSave(false)
      setEditing(false)
      // Refresh the preview buffer + listing + stat so the new content/size show.
      queryClient.invalidateQueries({ queryKey: ['text-preview', src] })
      const dirPrefix = fileKey.includes('/')
        ? fileKey.slice(0, fileKey.lastIndexOf('/') + 1)
        : ''
      queryClient.invalidateQueries({ queryKey: ['list', storage, dirPrefix] })
      queryClient.invalidateQueries({ queryKey: ['stat', storage, fileKey] })
    } catch (err) {
      setConfirmSave(false)
      if (err instanceof ApiError && err.status === 401) {
        // Stay in edit mode; the token prompt's retry re-runs doSave.
        setSaveAuth(true)
      } else if (err instanceof ApiError) {
        toast.error(err.message)
      } else {
        toast.error(String(err))
      }
    } finally {
      setSaving(false)
    }
  }, [storage, fileKey, draft, src, queryClient, navigationBlocker])

  const cancelEdit = useCallback(() => {
    if (dirty) setDiscardConfirm(true)
    else setEditing(false)
  }, [dirty])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-md bg-muted/30">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-background/50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {isPartial && (
            <span
              className="flex shrink-0 items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
              title="Only part of the file has been loaded — click 'Load more' to fetch the rest."
            >
              <AlertCircle className="size-3" />
              Partial{progressPercent !== null ? ` · ${progressPercent}%` : ''}
            </span>
          )}
          <span className="truncate text-xs text-muted-foreground">{statusLine}</span>
        </div>
        <div className="flex items-center gap-2">
          {showSpinner && (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}
          {editing ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7"
                disabled={saving}
                onClick={cancelEdit}
              >
                <X className="size-3.5" />
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-7 shadow-sm"
                disabled={saving || !dirty}
                onClick={() => setConfirmSave(true)}
              >
                {saving ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Save className="size-3.5" />
                )}
                Save
              </Button>
            </>
          ) : (
            <>
          {/* Persistent across modal opens via localStorage. Variant swap
              (`default` filled when pressed, `outline` bordered when off)
              gives the toggle a louder visual state than a colour change
              alone; the radix Tooltip provides a real hover hint with a 200ms
              delay so it's discoverable but not intrusive. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant={showLineNumbers ? 'default' : 'outline'}
                aria-pressed={showLineNumbers}
                aria-label="Toggle line numbers"
                onClick={() => setShowLineNumbers(!showLineNumbers)}
              >
                <ListOrdered />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {showLineNumbers ? 'Hide line numbers' : 'Show line numbers'}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                aria-live="polite"
                disabled={lines.length === 0}
                onClick={handleCopy}
              >
                {copied ? <Check /> : <Copy />}
                <span className="sr-only">
                  {copied
                    ? 'Text copied'
                    : state.done
                      ? 'Copy text'
                      : 'Copy loaded text'}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {copied
                ? 'Copied'
                : state.done
                  ? 'Copy text'
                  : 'Copy loaded text'}
            </TooltipContent>
          </Tooltip>
          {rowsFormat && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  onClick={openRowsPage}
                  disabled={!storage}
                  className="h-7 shadow-sm"
                >
                  <LayoutList className="size-3.5" />
                  Browse as cards
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Open the Rows view for this file
              </TooltipContent>
            </Tooltip>
          )}
          {canConvert && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => handleConvert(false)}
                  disabled={converting || convertJobId !== null}
                  className="h-7 shadow-sm"
                >
                  {converting || convertJobId !== null
                    ? <Loader2 className="size-3.5 animate-spin" />
                    : <FileDown className="size-3.5" />}
                  {converting || convertJobId !== null ? 'Converting…' : convertLabel}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Convert this file to Parquet using DuckDB
              </TooltipContent>
            </Tooltip>
          )}
              {canWrite && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 shadow-sm"
                      disabled={tooLargeToEdit}
                      onClick={enterEdit}
                    >
                      <Pencil className="size-3.5" />
                      Edit
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {tooLargeToEdit
                      ? 'File is too large to edit in the browser'
                      : 'Edit this file'}
                  </TooltipContent>
                </Tooltip>
              )}
              {/* Raw/Rendered toggle — only shown for Markdown files (.md /
                  .markdown). Mirrors the line-numbers toggle style: `default`
                  variant when the mode is active, `outline` otherwise, so the
                  current state is immediately readable without hover. */}
              {isMarkdown && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant={view === 'raw' ? 'default' : 'outline'}
                        aria-pressed={view === 'raw'}
                        aria-label="View raw source"
                        onClick={() => setView('raw')}
                      >
                        <Code />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>View raw source</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant={view === 'rendered' ? 'default' : 'outline'}
                        aria-pressed={view === 'rendered'}
                        aria-label="View rendered Markdown"
                        onClick={() => setView('rendered')}
                      >
                        <BookText />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>View rendered Markdown</TooltipContent>
                  </Tooltip>
                </>
              )}
            </>
          )}
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            className="h-7 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Syntax highlighting language"
          >
            {SUPPORTED_LANGUAGES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {showHttpfsWarning && (
        <div className="px-3 pt-3">
          <Alert className="border-amber-500/50 text-amber-600 dark:text-amber-400">
            <AlertCircle className="size-4" />
            <AlertTitle>httpfs extension unavailable</AlertTitle>
            <AlertDescription>
              The DuckDB httpfs extension could not be loaded — the conversion
              will fail. The server needs outbound network access to the DuckDB
              extension repository on first use. Alternatively, pre-install on
              the host:{' '}
              <code className="font-mono text-xs">
                duckdb -c &quot;INSTALL httpfs; INSTALL aws;&quot;
              </code>
            </AlertDescription>
          </Alert>
        </div>
      )}

      {showRowsHint && (
        <div className="px-3 pt-3">
          <RowsViewHint onOpen={openRowsPage} disabled={!storage} />
        </div>
      )}

      {/* `relative` anchors the floating "Load more" overlay below. */}
      <div className="relative flex-1 overflow-hidden">
        {editing ? (
          <div
            className="hljs h-full w-full overflow-auto"
            onKeyDown={(e) => {
              // Cmd/Ctrl+S opens the save confirmation (mirrors editors).
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault()
                if (dirty && !saving) setConfirmSave(true)
              }
            }}
          >
            <Editor
              value={draft}
              onValueChange={setDraft}
              highlight={(code) => highlight(code, lang)}
              padding={16}
              textareaClassName="focus:outline-none"
              className="min-h-full font-mono text-xs leading-relaxed"
              style={{ minHeight: '100%' }}
            />
          </div>
        ) : (
          <>
        {errorMessage && (
          <div className="p-3">
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Failed to load text</AlertTitle>
              <AlertDescription className="flex flex-col gap-3">
                <span>{errorMessage}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (state.text.length === 0) void textQuery.refetch()
                    else void textQuery.fetchNextPage()
                  }}
                  disabled={loading}
                  className="self-start"
                >
                  {loading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RotateCw className="size-4" />
                  )}
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        )}
        {!errorMessage && state.text.length === 0 && firstLoading && (
          <div className="flex w-full flex-col gap-2 p-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        )}
        {!errorMessage && state.text.length === 0 && !loading && state.done && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            File is empty.
          </div>
        )}
        {/* Rendered Markdown view — only for .md / .markdown files when the
            user has selected the Rendered tab. Renders the accumulated text
            (`state.text`) through marked + DOMPurify. When the file hasn't
            been fully loaded yet, the Partial badge + Load more button above
            remain visible so the user can fetch more before re-reading. */}
        {isMarkdown && view === 'rendered' && state.text.length > 0 && (
          <div className="h-full w-full overflow-auto px-6 py-5">
            <Suspense
              fallback={
                <div className="flex w-full flex-col gap-2">
                  {Array.from({ length: 12 }).map((_, i) => (
                    <Skeleton key={i} className="h-4 w-full" />
                  ))}
                </div>
              }
            >
              <MarkdownProse body={state.text} />
            </Suspense>
          </div>
        )}
        {(!isMarkdown || view === 'raw') && lines.length > 0 && (
          // Per-row flex: gutter (fixed `ch`-width, right-aligned, top-anchored
          // so a wrapped content row keeps the number at its first visual line)
          // + content (`whitespace-pre-wrap break-words` so long lines wrap
          // inside their column without misaligning the gutter). The outer
          // `hljs` class still picks up the theme's background and palette.
          <div
            ref={scrollRef}
            className="hljs h-full w-full overflow-auto p-4 font-mono text-xs leading-relaxed"
          >
            {/* Find bar — floats top-right of scroll container */}
            {findOpen && (
              <div className="sticky top-0 z-10 float-right ml-2 mb-2 flex items-center gap-1 rounded-md border bg-background p-1 shadow-lg">
                <Search className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
                <Input
                  ref={findInputRef}
                  value={findQuery}
                  onChange={(e) => {
                    setFindQuery(e.target.value)
                    setActiveMatch(0)
                  }}
                  placeholder="Find…"
                  className="h-6 w-40 border-0 p-0 px-1 text-xs shadow-none focus-visible:ring-0"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      setActiveMatch((prev) =>
                        matches.length ? (prev + 1) % matches.length : 0,
                      )
                    } else if (e.key === 'Enter' && e.shiftKey) {
                      e.preventDefault()
                      setActiveMatch((prev) =>
                        matches.length
                          ? (prev - 1 + matches.length) % matches.length
                          : 0,
                      )
                    } else if (e.key === 'Escape') {
                      e.stopPropagation()
                      e.preventDefault()
                      setFindOpen(false)
                    }
                  }}
                />
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {matches.length === 0 && findQuery
                    ? 'No results'
                    : matches.length > 0
                      ? `${activeMatch + 1} / ${matches.length}`
                      : ''}
                </span>
                <button
                  type="button"
                  aria-label="Previous match"
                  className="rounded p-0.5 hover:bg-muted disabled:opacity-40"
                  disabled={matches.length === 0}
                  onClick={() =>
                    setActiveMatch((prev) =>
                      matches.length
                        ? (prev - 1 + matches.length) % matches.length
                        : 0,
                    )
                  }
                >
                  <ChevronUp className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Next match"
                  className="rounded p-0.5 hover:bg-muted disabled:opacity-40"
                  disabled={matches.length === 0}
                  onClick={() =>
                    setActiveMatch((prev) =>
                      matches.length ? (prev + 1) % matches.length : 0,
                    )
                  }
                >
                  <ChevronDown className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Close find bar"
                  className="rounded p-0.5 hover:bg-muted"
                  onClick={() => setFindOpen(false)}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )}
            {/* Partial-load notice when find is open but file isn't fully loaded */}
            {findOpen && !state.done && (
              <div className="sticky top-0 z-10 mb-2 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-50/80 px-3 py-1.5 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                <AlertCircle className="size-3.5 shrink-0" />
                Searching loaded portion ·{' '}
                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={() => void startLoadAll()}
                >
                  Load all to search the whole file
                </button>
              </div>
            )}
            {lines.map((line, i) => {
              const lineNum = i + 1
              const html = highlightedLines?.[i] ?? null
              const lineMatchState =
                findOpen && findQuery
                  ? (matchesByLine[i] ?? { ranges: [], activeIdx: -1 })
                  : { ranges: [], activeIdx: -1 }
              const lineMatches = lineMatchState.ranges
              const activeIdxInLine = lineMatchState.activeIdx
              const isDeepLine = deepLine === lineNum
              return (
                <div
                  key={i}
                  data-line={lineNum}
                  className={cn(
                    'flex',
                    showLineNumbers && 'gap-3',
                    isDeepLine && 'rounded bg-amber-300/30 ring-1 ring-amber-400/50',
                  )}
                >
                  {showLineNumbers && (
                    <button
                      type="button"
                      aria-label={`Copy link to line ${lineNum}`}
                      className="shrink-0 select-none text-right text-muted-foreground/60 tabular-nums hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      style={{ width: `${gutterChars}ch` }}
                      onClick={() => {
                        const url = `${window.location.href.split('#')[0]}#L${lineNum}`
                        navigator.clipboard?.writeText(url).catch(() => {})
                        toast.success('Link copied')
                        navigate(
                          { hash: `#L${lineNum}` },
                          { replace: true },
                        )
                      }}
                    >
                      {lineNum}
                    </button>
                  )}
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                    {lineMatches.length > 0 ? (
                      renderLineWithMarks(line, lineMatches, activeIdxInLine)
                    ) : html !== null ? (
                      <span dangerouslySetInnerHTML={{ __html: html }} />
                    ) : (
                      line
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        )}
        {/* Floating "Load more" overlays the bottom-right of the preview so
            the user can advance without scrolling to the end of the buffer.
            Hidden when:
              - the file fits in one fetch (small files; `done` is true after
                the first chunk),
              - EOF was reached after additional clicks,
              - there's nothing loaded yet,
              - an error is showing.
            Disabled mid-fetch to suppress duplicate clicks. */}
        {!state.done && state.text.length > 0 && !errorMessage && (
          <div className="absolute right-4 bottom-4 flex gap-2">
            {loadingAll ? (
              // While the load-all loop is running, the two action buttons
              // collapse into a single cancel control. The header's Partial
              // badge keeps showing live progress, so there's no need to
              // duplicate it here.
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-3 text-xs shadow-lg hover:shadow-xl"
                onClick={cancelLoadAll}
              >
                <Loader2 className="mr-1 size-4 animate-spin" />
                Stop
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 text-xs shadow-lg hover:shadow-xl"
                  disabled={loadingNext}
                  onClick={() => setLoadAllOpen(true)}
                >
                  <Download className="mr-1 size-3.5" />
                  Load all
                </Button>
                <Button
                  size="sm"
                  className="h-8 px-3 text-xs shadow-lg ring-2 ring-amber-500/40 ring-offset-2 ring-offset-background hover:shadow-xl"
                  disabled={loadingNext}
                  onClick={() => void textQuery.fetchNextPage()}
                >
                  {loadingNext && <Loader2 className="mr-1 size-4 animate-spin" />}
                  Load more
                </Button>
              </>
            )}
          </div>
        )}
          </>
        )}
      </div>
      <Dialog open={loadAllOpen} onOpenChange={setLoadAllOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Load the entire file?</DialogTitle>
            <DialogDescription>
              {remainingBytes !== null && state.totalBytes !== null ? (
                <>
                  About{' '}
                  <span className="font-medium text-foreground">
                    {formatBytes(remainingBytes)}
                  </span>{' '}
                  still needs to be fetched
                  {' '}
                  ({formatBytes(state.totalBytes)} total).
                </>
              ) : (
                <>
                  The server didn’t report a file size, so the total amount to
                  load is unknown.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {loadAllSeverity !== 'light' && (
            <Alert variant={loadAllSeverity === 'heavy' ? 'destructive' : 'default'}>
              <AlertCircle className="size-4" />
              <AlertTitle>
                {loadAllSeverity === 'heavy'
                  ? 'This may freeze the browser'
                  : 'This may take a moment'}
              </AlertTitle>
              <AlertDescription>
                {loadAllSeverity === 'heavy'
                  ? 'Loading and syntax-highlighting more than 20 MiB of text in one tab can stall or run out of memory. Consider downloading the file instead, or keep using Load more.'
                  : 'Several MiB of text plus syntax highlighting can be noticeably slow. You can cancel partway through.'}
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setLoadAllOpen(false)}
            >
              <X className="size-3.5" />
              Cancel
            </Button>
            <Button
              variant={loadAllSeverity === 'heavy' ? 'destructive' : 'default'}
              onClick={() => void startLoadAll()}
            >
              <Download className="size-3.5" />
              {loadAllSeverity === 'heavy' ? 'Load anyway' : 'Load entire file'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={showOverwriteDialog} onOpenChange={setShowOverwriteDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Overwrite existing file?</DialogTitle>
            <DialogDescription>
              The output file already exists. Converting will replace it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1 rounded-md border bg-muted/50 px-3 py-2.5 text-sm">
            <p className="text-xs font-medium text-muted-foreground">Source</p>
            <p className="break-all font-mono text-foreground">{fileKey}</p>
            <div className="flex items-center gap-1 pt-0.5 text-muted-foreground">
              <ArrowDown className="size-3.5" />
              <p className="text-xs font-medium text-destructive">
                Output (will be overwritten)
              </p>
            </div>
            <p className="break-all font-mono text-foreground">{outputKey}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowOverwriteDialog(false)}>
              <X className="size-3.5" />
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setShowOverwriteDialog(false)
                void handleConvert(true)
              }}
            >
              <FileDown className="size-3.5" />
              Overwrite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Conversion failed dialog — shows classified error summary, hint, and
          the raw DuckDB message so users can diagnose and fix the problem. */}
      <Dialog
        open={convertError !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConvertError(null)
            setConvertErrRawCopied(false)
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Conversion failed</DialogTitle>
            {convertError && (
              <DialogDescription className="break-words">
                {convertError.message}
              </DialogDescription>
            )}
          </DialogHeader>

          {convertError?.hint && (
            <Alert className="min-w-0">
              <AlertCircle className="size-4" />
              <AlertTitle>How to fix</AlertTitle>
              <AlertDescription className="min-w-0 break-words">
                {convertError.hint}
              </AlertDescription>
            </Alert>
          )}

          {convertError?.raw && (
            <div className="min-w-0 space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">
                  DuckDB error
                </p>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-live="polite"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(convertError.raw ?? '')
                      setConvertErrRawCopied(true)
                      if (convertErrCopyTimeoutRef.current) clearTimeout(convertErrCopyTimeoutRef.current)
                      convertErrCopyTimeoutRef.current = setTimeout(() => setConvertErrRawCopied(false), 1500)
                    } catch {
                      // Clipboard API unavailable in insecure contexts; silent no-op.
                    }
                  }}
                >
                  {convertErrRawCopied ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                  <span className="sr-only">
                    {convertErrRawCopied
                      ? 'DuckDB error copied'
                      : 'Copy DuckDB error'}
                  </span>
                </Button>
              </div>
              <pre className="max-h-40 overflow-auto rounded-md border bg-muted/50 px-3 py-2 text-xs whitespace-pre-wrap break-words">
                {convertError.raw}
              </pre>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConvertError(null)
                setConvertErrRawCopied(false)
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {convertAuthOverwrite !== null && (
        <TokenPrompt
          onSubmit={() => {
            // TokenPrompt stored the token; retry the convert with the same
            // overwrite intent now that the request can authenticate.
            const overwrite = convertAuthOverwrite
            setConvertAuthOverwrite(null)
            void handleConvert(overwrite)
          }}
          onCancel={() => setConvertAuthOverwrite(null)}
        />
      )}

      {/* Save confirmation — every write passes through a confirm step. */}
      <ConfirmDialog
        open={confirmSave}
        title="Save changes?"
        description={
          <>
            This overwrites{' '}
            <span className="font-mono break-all text-foreground">{fileKey}</span>{' '}
            on the server.
          </>
        }
        confirmLabel="Save"
        busy={saving}
        onConfirm={() => void doSave()}
        onCancel={() => setConfirmSave(false)}
      />
      <ConfirmDialog
        open={discardConfirm}
        title="Discard changes?"
        description="Your unsaved edits will be lost."
        confirmLabel="Discard"
        destructive
        onConfirm={() => {
          setDiscardConfirm(false)
          setEditing(false)
        }}
        onCancel={() => setDiscardConfirm(false)}
      />
      <ConfirmDialog
        open={navigationBlocker.state === 'blocked'}
        title="Leave without saving?"
        description="Your unsaved edits will be lost."
        confirmLabel="Leave"
        destructive
        onConfirm={() => {
          if (navigationBlocker.state === 'blocked') {
            navigationBlocker.proceed()
          }
        }}
        onCancel={() => {
          if (navigationBlocker.state === 'blocked') {
            navigationBlocker.reset()
          }
        }}
      />
      {saveAuth && (
        <TokenPrompt
          onSubmit={() => {
            // Token stored; retry the save now that the request can authenticate.
            setSaveAuth(false)
            void doSave()
          }}
          onCancel={() => setSaveAuth(false)}
        />
      )}
      {/* Progress dialog for the background conversion job. The component is
          only mounted while a job is in flight so its useQuery hook starts /
          stops cleanly — avoids hooks that run unconditionally. */}
      {convertJobId !== null && storage && (
        <ConvertProgressDialog
          jobId={convertJobId}
          fileKey={fileKey}
          onDone={(outputKey, rowsWritten, elapsedMs) => {
            setConvertJobId(null)
            toast.success(
              `Converted to ${outputKey} (${rowsWritten} rows, ${elapsedMs}ms)`,
            )
            const dirPrefix = fileKey.includes('/')
              ? fileKey.slice(0, fileKey.lastIndexOf('/') + 1)
              : ''
            queryClient.invalidateQueries({ queryKey: ['list', storage, dirPrefix] })
          }}
          onFailed={(detail) => {
            setConvertJobId(null)
            setConvertError(detail)
          }}
        />
      )}
    </div>
  )
}

// --- ConvertProgressDialog ---------------------------------------------------

/** Props for the background-job progress dialog. */
interface ConvertProgressDialogProps {
  jobId: string
  fileKey: string
  onDone: (outputKey: string, rowsWritten: number, elapsedMs: number) => void
  onFailed: (detail: ErrorDetail) => void
}

/**
 * Polls GET /api/convert/{jobId} every 1.5 s until the conversion finishes,
 * then delegates to `onDone` or `onFailed`. Displayed as an uncloseable modal
 * so the user knows a job is in flight while the source tab is open.
 *
 * The component is intentionally separate from TextPreview so that the
 * `useQuery` hook is only mounted when a job is actually running — avoids a
 * polling query that sits idle between conversions.
 */
function ConvertProgressDialog({
  jobId,
  fileKey,
  onDone,
  onFailed,
}: ConvertProgressDialogProps) {
  const query = useQuery({
    queryKey: ['convert-status', jobId],
    queryFn: () => getConvertStatus(jobId),
    // Treat all query errors as terminal — don't retry so a 404 (job pruned
    // or server restarted) surfaces immediately instead of spinning forever.
    retry: false,
    // Stop refetching once the job reaches a terminal state or errors out.
    refetchInterval: (q) => {
      if (q.state.error) return false
      const s = q.state.data?.state
      return s === 'done' || s === 'failed' ? false : 1500
    },
  })

  const status = query.data

  // When the status transitions to a terminal state (or errors), bubble the
  // result up to the parent. useEffect is the correct place — never call
  // state-setters / callbacks in render.
  useEffect(() => {
    if (query.isError) {
      if (query.error instanceof ApiError) {
        onFailed(extractErrorDetail(query.error))
      } else {
        onFailed({ message: String(query.error) })
      }
      return
    }
    if (!status) return
    if (status.state === 'done') {
      onDone(
        status.output_key ?? '',
        status.rows_written ?? 0,
        status.elapsed_ms,
      )
    } else if (status.state === 'failed') {
      onFailed({
        message: status.summary ?? 'The conversion failed.',
        hint: status.hint,
        raw: status.raw,
      })
    }
    // Omit onDone/onFailed from deps: they're recreated on every parent
    // render (inline arrows), but we only want to fire when terminal state
    // arrives, not on unrelated TextPreview re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, query.isError, query.error])

  // Format elapsed seconds for display.
  const elapsedSec = status ? Math.floor(status.elapsed_ms / 1000) : 0

  return (
    <Dialog open>
      <DialogContent
        className="sm:max-w-sm"
        // Prevent closing via Escape or backdrop click while conversion is running.
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Converting…</DialogTitle>
          <DialogDescription className="break-all">
            {fileKey}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-4">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Running on server — elapsed{' '}
            <span className="font-medium tabular-nums text-foreground">
              {elapsedSec}s
            </span>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
