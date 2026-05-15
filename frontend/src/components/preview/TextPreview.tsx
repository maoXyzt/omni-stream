import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  AlertCircle,
  Check,
  Copy,
  LayoutList,
  ListOrdered,
  Loader2,
} from 'lucide-react'

import { apiClient, ApiError } from '@/api/client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useLineNumbers } from '@/hooks/use-line-numbers'
import {
  SUPPORTED_LANGUAGES,
  detectLanguage,
  ensureLanguage,
  highlight,
  isLanguageBundled,
} from '@/lib/highlight'
import { detectFormat } from '@/lib/rows-source'
import { cn } from '@/lib/utils'

import type { PreviewerProps } from './types'

// Query param key that the Rows view writes its rule config into. Forwarded
// when the user jumps from text preview to the Rows page so a shared link
// with rules pre-applied still works.
const ROWS_PARAM = 'rows'

// One constant doing two jobs: it's the first-chunk size *and* the threshold
// above which chunked loading kicks in. A file at or below this size fits in
// one fetch — the response comes back as `isFull` and there's nothing more to
// load, so the "Load more" button never appears. A file larger than this
// returns its first MB, the button surfaces, and each additional click pulls
// another MB.
const CHUNK_BYTES = 1024 * 1024

interface LoadState {
  /// Concatenated text from every chunk fetched so far. Append-only.
  text: string
  /// Number of source bytes already consumed.
  bytesLoaded: number
  /// Total file size when known (from `Content-Range: bytes A-B/TOTAL` or a
  /// 200 response with `Content-Length`). `null` when unknown.
  totalBytes: number | null
  /// True once the entire file has been read.
  done: boolean
}

const INITIAL_STATE: LoadState = {
  text: '',
  bytesLoaded: 0,
  totalBytes: null,
  done: false,
}

interface RangeFetchResult {
  body: string
  endByte: number
  totalBytes: number | null
  isFull: boolean
}

// Format: `bytes 0-262143/1500000` or `bytes 0-262143/*`.
function parseContentRange(
  header: string | undefined,
): { end: number; total: number | null } | null {
  if (!header) return null
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header)
  if (!m) return null
  return {
    end: Number(m[2]),
    total: m[3] === '*' ? null : Number(m[3]),
  }
}

async function fetchRange(
  src: string,
  startByte: number,
  endByte: number,
): Promise<RangeFetchResult> {
  const res = await apiClient.get<string>(src, {
    responseType: 'text',
    headers: {
      // Override the global JSON Accept so the proxy returns the raw body.
      Accept: 'text/plain, */*',
      Range: `bytes=${startByte}-${endByte}`,
    },
    transformResponse: [(value) => value],
  })
  const body = res.data
  const cr = parseContentRange(res.headers['content-range'] as string | undefined)
  if (cr) {
    return {
      body,
      endByte: cr.end,
      totalBytes: cr.total,
      isFull: cr.total !== null && cr.end + 1 >= cr.total,
    }
  }
  // 200 OK fallback — server ignored Range and returned the whole body. That
  // can happen for files smaller than the requested window on some backends,
  // or when middleware strips the Range header.
  const len =
    Number(res.headers['content-length'] as string | undefined) || body.length
  return {
    body,
    endByte: Math.max(0, len - 1),
    totalBytes: len,
    isFull: true,
  }
}

function mergeChunk(prev: LoadState, fetched: RangeFetchResult): LoadState {
  return {
    text: prev.text + fetched.body,
    bytesLoaded: fetched.endByte + 1,
    totalBytes: fetched.totalBytes ?? prev.totalBytes,
    done: fetched.isFull,
  }
}

function formatBytes(n: number | null): string {
  if (n === null) return '?'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GiB`
}

function splitLines(text: string): string[] {
  if (!text) return []
  // Strip a single trailing newline so a file ending in `\n` doesn't render a
  // phantom empty last row. Multiple trailing newlines still produce blank
  // rows on purpose.
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  return trimmed.split('\n')
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

  // Cache key on storage + path so navigating between files (or storages)
  // doesn't bleed state.
  const cacheKey = useMemo(() => `${storage ?? ''}:${fileKey}`, [storage, fileKey])
  const [state, setState] = useState<LoadState>(INITIAL_STATE)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Inflight guard prevents double-fetch on rapid "Load more" clicks.
  const inflight = useRef(false)
  const cacheKeyRef = useRef(cacheKey)

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

  // --- Chunked fetch -----------------------------------------------------

  // Callers pass the start byte explicitly so this callback's identity stays
  // stable across renders (no state mirror needed — the
  // react-hooks/immutability rule forbids that pattern). Initial load passes
  // 0; the "Load more" button passes the current `state.bytesLoaded`.
  const fetchNext = useCallback(
    async (forKey: string, startByte: number) => {
      if (inflight.current) return
      inflight.current = true
      setLoading(true)
      setError(null)
      try {
        const end = startByte + CHUNK_BYTES - 1
        const fetched = await fetchRange(src, startByte, end)
        // Drop the result if the user navigated mid-flight.
        if (cacheKeyRef.current !== forKey) return
        setState((prev) => mergeChunk(prev, fetched))
      } catch (e) {
        if (cacheKeyRef.current !== forKey) return
        setError(
          e instanceof ApiError
            ? `${e.status} — ${e.message}`
            : e instanceof Error
              ? e.message
              : 'fetch failed',
        )
      } finally {
        inflight.current = false
        setLoading(false)
      }
    },
    [src],
  )

  // Reset on file change and kick off the first fetch.
  useEffect(() => {
    cacheKeyRef.current = cacheKey
    setState(INITIAL_STATE)
    setError(null)
    inflight.current = false
    fetchNext(cacheKey, 0)
  }, [cacheKey, fetchNext])

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
    const eof = state.done ? ' · EOF' : ''
    return `${lineLabel} · ${bytes}${eof}`
  })()

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
        <span className="truncate text-xs text-muted-foreground">{statusLine}</span>
        <div className="flex items-center gap-2">
          {showSpinner && (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
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
                  variant="outline"
                  onClick={openRowsPage}
                  disabled={!storage}
                  className="h-7"
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

      {/* `relative` anchors the floating "Load more" overlay below. */}
      <div className="relative flex-1 overflow-hidden">
        {error && (
          <div className="p-3">
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Failed to load text</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        )}
        {!error && state.text.length === 0 && loading && (
          <div className="flex w-full flex-col gap-2 p-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        )}
        {!error && state.text.length === 0 && !loading && state.done && (
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
        {!state.done && state.text.length > 0 && !error && (
          <Button
            size="sm"
            className="absolute right-4 bottom-4 h-8 px-3 text-xs shadow-lg hover:shadow-xl"
            disabled={loading}
            onClick={() => fetchNext(cacheKey, state.bytesLoaded)}
          >
            {loading && <Loader2 className="mr-1 size-3 animate-spin" />}
            Load more
          </Button>
        )}
      </div>
    </div>
  )
}
