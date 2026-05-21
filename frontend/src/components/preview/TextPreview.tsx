import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useInfiniteQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  LayoutList,
  ListOrdered,
  Loader2,
  RotateCw,
  X,
} from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
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
import { useLineNumbers } from '@/hooks/use-line-numbers'
import { useRowsViewHint } from '@/hooks/use-rows-view-hint'
import {
  SUPPORTED_LANGUAGES,
  detectLanguage,
  ensureLanguage,
  highlight,
  isLanguageBundled,
} from '@/lib/highlight'
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

type LoadAllSeverity = 'light' | 'warn' | 'heavy'

function loadAllSeverityFor(remainingBytes: number | null): LoadAllSeverity {
  // Unknown total → warn (we have no idea how much we'd actually pull).
  if (remainingBytes === null) return 'warn'
  if (remainingBytes >= LOAD_ALL_HEAVY_BYTES) return 'heavy'
  if (remainingBytes >= LOAD_ALL_WARN_BYTES) return 'warn'
  return 'light'
}

export function TextPreview({ fileKey, src, storage }: PreviewerProps) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
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
                aria-label="Copy text"
                disabled={lines.length === 0}
                onClick={handleCopy}
              >
                {copied ? <Check /> : <Copy />}
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

      {showRowsHint && (
        <div className="px-3 pt-3">
          <RowsViewHint onOpen={openRowsPage} disabled={!storage} />
        </div>
      )}

      {/* `relative` anchors the floating "Load more" overlay below. */}
      <div className="relative flex-1 overflow-hidden">
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
        {lines.length > 0 && (
          // Per-row flex: gutter (fixed `ch`-width, right-aligned, top-anchored
          // so a wrapped content row keeps the number at its first visual line)
          // + content (`whitespace-pre-wrap break-words` so long lines wrap
          // inside their column without misaligning the gutter). The outer
          // `hljs` class still picks up the theme's background and palette.
          <div className="hljs h-full w-full overflow-auto p-4 font-mono text-xs leading-relaxed">
            {lines.map((line, i) => {
              const html = highlightedLines?.[i] ?? null
              return (
                <div key={i} className={cn('flex', showLineNumbers && 'gap-3')}>
                  {showLineNumbers && (
                    <span
                      aria-hidden="true"
                      className="shrink-0 select-none text-right text-muted-foreground/60 tabular-nums"
                      style={{ width: `${gutterChars}ch` }}
                    >
                      {i + 1}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                    {html !== null ? (
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
    </div>
  )
}
