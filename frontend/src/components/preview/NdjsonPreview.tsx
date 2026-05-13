import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'

import { apiClient, ApiError } from '@/api/client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ensureLanguage, highlight, isLanguageBundled } from '@/lib/highlight'

import type { PreviewerProps } from './types'

// 256 KiB per fetch — at typical NDJSON line widths (100–500 bytes) this
// surfaces several hundred lines on the first load without forcing the
// browser to pull a multi-MB log file before anything renders.
const CHUNK_BYTES = 256 * 1024
// All NDJSON lines are JSON values, so highlight the buffer as JSON. The
// highlighter is lexical and copes fine with the file being many concatenated
// JSON values rather than a single object.
const HIGHLIGHT_LANG = 'json'

interface LoadState {
  /// Concatenated text from every chunk fetched so far. Append-only; the
  /// `<pre>` re-highlights on each update.
  text: string
  /// Number of source bytes already consumed (covered by completed chunk
  /// fetches), regardless of how many lines they produced.
  bytesLoaded: number
  /// Total file size when known (from `Content-Range: bytes A-B/TOTAL` or a
  /// 200 response with `Content-Length`). `null` when the server returned
  /// `*` for the total.
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
  /// Inclusive end-byte covered by this response.
  endByte: number
  totalBytes: number | null
  /// True iff the response covers the entire file (either 200 OK, or 206
  /// whose end matches `total - 1`).
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
      Accept: 'application/x-ndjson, text/plain, */*',
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

function countLines(text: string): number {
  if (!text) return 0
  // Number of newlines, plus 1 if the buffer doesn't end with one (the last
  // partial line still counts visually). On Windows-authored files \r\n
  // produces the same count because we only consider \n.
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++
  }
  if (!text.endsWith('\n')) count++
  return count
}

export function NdjsonPreview({ fileKey, src, storage }: PreviewerProps) {
  // `src` and `storage` are siblings in routing; we key the cache on both so
  // navigating between two different files (or storages) doesn't bleed state.
  const cacheKey = useMemo(() => `${storage ?? ''}:${fileKey}`, [storage, fileKey])
  const [state, setState] = useState<LoadState>(INITIAL_STATE)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Inflight guard prevents double-fetch on StrictMode-doubled effects and on
  // rapid "Load more" clicks.
  const inflight = useRef(false)
  // Reset on file change.
  const cacheKeyRef = useRef(cacheKey)

  // The JSON grammar is bundled (see `lib/highlight.ts`), so the ready gate is
  // basically a no-op — kept for parity with TextPreview in case the bundling
  // set changes.
  const [ready, setReady] = useState(() => isLanguageBundled(HIGHLIGHT_LANG))
  useEffect(() => {
    if (isLanguageBundled(HIGHLIGHT_LANG)) {
      setReady(true)
      return
    }
    let cancelled = false
    ensureLanguage(HIGHLIGHT_LANG).then(() => {
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Callers pass the start byte explicitly (rather than the closure reading
  // it off state) so this callback's identity stays stable across renders and
  // doesn't need a state mirror — which the react-hooks/immutability rule
  // (rightly) forbids. Initial load passes 0; the "Load more" button passes
  // the current `state.bytesLoaded`.
  const fetchNext = useCallback(
    async (forKey: string, startByte: number) => {
      if (inflight.current) return
      inflight.current = true
      setLoading(true)
      setError(null)
      try {
        const end = startByte + CHUNK_BYTES - 1
        const fetched = await fetchRange(src, startByte, end)
        // Drop the result if the user navigated to a different file mid-flight.
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

  // Reset when the file changes and kick off the first fetch.
  useEffect(() => {
    cacheKeyRef.current = cacheKey
    setState(INITIAL_STATE)
    setError(null)
    inflight.current = false
    fetchNext(cacheKey, 0)
  }, [cacheKey, fetchNext])

  const highlighted = useMemo(() => {
    if (!state.text || !ready) return null
    return highlight(state.text, HIGHLIGHT_LANG)
  }, [state.text, ready])

  const lineCount = useMemo(() => countLines(state.text), [state.text])

  const statusLine = (() => {
    const bytes = `${formatBytes(state.bytesLoaded)} / ${formatBytes(state.totalBytes)}`
    const lines = `${lineCount} line${lineCount === 1 ? '' : 's'}`
    const eof = state.done ? ' · EOF' : ''
    return `${lines} · ${bytes}${eof}`
  })()

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-md bg-muted/30">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-background/50 px-3 py-2 text-xs text-muted-foreground">
        <span className="truncate">{statusLine}</span>
        {loading && <Loader2 className="size-3.5 shrink-0 animate-spin" />}
      </div>

      {/* `relative` anchors the floating "Load more" button below; `overflow-hidden`
          still clips the inner `<pre>`'s own scrollbar inside this region. */}
      <div className="relative flex-1 overflow-hidden">
        {error && (
          <div className="p-3">
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Failed to load NDJSON</AlertTitle>
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
        {state.text.length > 0 && (
          <pre className="hljs h-full w-full overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
            {highlighted !== null ? (
              <code dangerouslySetInnerHTML={{ __html: highlighted }} />
            ) : (
              <code>{state.text}</code>
            )}
          </pre>
        )}
        {/* Floating "Load more" overlays the bottom-right of the preview so the
            user can advance without scrolling to the end of the buffer. Hidden
            once EOF is reached (rather than disabled — at EOF there's nothing
            to advance to). Disabled mid-fetch to suppress duplicate clicks. */}
        {!state.done && state.text.length > 0 && !error && (
          // Solid primary fill (instead of `outline`) so the button reads
          // clearly over `hljs`-highlighted code; `shadow-lg` adds elevation
          // so it looks like it floats over the buffer rather than sitting
          // in-flow.
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
