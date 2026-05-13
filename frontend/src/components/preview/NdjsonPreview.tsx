import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'

import { apiClient, ApiError } from '@/api/client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import type { PreviewerProps } from './types'

// 256 KiB per fetch — at typical NDJSON line widths (100–500 bytes) this
// surfaces ~500–2500 rows on the first load, which is enough to see the
// shape of a file without forcing the user to wait on a multi-MB pull.
const CHUNK_BYTES = 256 * 1024
// Long values are truncated in the table; full value visible on hover.
const CELL_PREVIEW_CHARS = 200
const ROW_NUMBER_WIDTH = 'w-12'

type ParsedRow =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; raw: string; error: string }

interface LoadState {
  rows: ParsedRow[]
  /// First-seen union of keys across all parsed rows. Order is preserved so
  /// the table doesn't jitter as new chunks introduce new fields.
  columns: string[]
  /// Number of source bytes already consumed (covered by completed chunk
  /// fetches), regardless of how many lines they produced.
  bytesLoaded: number
  /// Total file size when known (from `Content-Range: bytes A-B/TOTAL` or a
  /// 200 response with `Content-Length`). `null` when the server returned
  /// `*` for the total.
  totalBytes: number | null
  /// Trailing partial line from the most-recent chunk (split on `\n`).
  /// Carried over to the next fetch so a row straddling the chunk boundary
  /// isn't dropped or corrupted.
  tail: string
  /// True once the entire file has been read.
  done: boolean
}

const INITIAL_STATE: LoadState = {
  rows: [],
  columns: [],
  bytesLoaded: 0,
  totalBytes: null,
  tail: '',
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

function parseOne(line: string): ParsedRow {
  const trimmed = line.trim()
  if (!trimmed) return { ok: false, raw: line, error: 'empty line' }
  try {
    const data = JSON.parse(trimmed) as unknown
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      // NDJSON spec is loose ("any JSON value per line"), but the table view
      // assumes objects. Scalars / arrays surface as a single `value` column
      // so they're still visible.
      return { ok: true, data: { value: data } }
    }
    return { ok: true, data: data as Record<string, unknown> }
  } catch (e) {
    return {
      ok: false,
      raw: line,
      error: e instanceof Error ? e.message : 'parse failed',
    }
  }
}

function mergeChunk(prev: LoadState, fetched: RangeFetchResult): LoadState {
  // Concat previous-chunk tail with new body, then split on `\n`. When the
  // server has signalled EOF the final segment is a full row; otherwise it's
  // an unfinished line that we stash as the new tail.
  const combined = prev.tail + fetched.body
  const segments = combined.split('\n')
  const newTail = fetched.isFull ? '' : (segments.pop() ?? '')
  // If isFull, segments includes the final line. If that final line is empty
  // (file ended with `\n`), the split produced a trailing '' — drop it so we
  // don't report a phantom empty row.
  if (fetched.isFull && segments.length > 0 && segments[segments.length - 1] === '') {
    segments.pop()
  }

  const rows: ParsedRow[] = [...prev.rows]
  const columnsSet = new Set(prev.columns)
  const columns = [...prev.columns]
  for (const seg of segments) {
    // Tolerate \r\n line endings on Windows-authored files.
    const line = seg.endsWith('\r') ? seg.slice(0, -1) : seg
    if (line.length === 0) continue
    const row = parseOne(line)
    rows.push(row)
    if (row.ok) {
      for (const k of Object.keys(row.data)) {
        if (!columnsSet.has(k)) {
          columnsSet.add(k)
          columns.push(k)
        }
      }
    }
  }

  return {
    rows,
    columns,
    bytesLoaded: fetched.endByte + 1,
    totalBytes: fetched.totalBytes ?? prev.totalBytes,
    tail: newTail,
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

function renderCell(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  // Objects / arrays — JSON.stringify is the compact form most useful in a
  // dense table cell. Hover shows the full string via the title attribute.
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
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

  const errorCount = useMemo(() => state.rows.filter((r) => !r.ok).length, [state.rows])

  const statusLine = (() => {
    const bytes = `${formatBytes(state.bytesLoaded)} / ${formatBytes(state.totalBytes)}`
    const rows = `${state.rows.length} row${state.rows.length === 1 ? '' : 's'}`
    const errs = errorCount > 0 ? ` · ${errorCount} parse error${errorCount === 1 ? '' : 's'}` : ''
    const eof = state.done ? ' · EOF' : ''
    return `${rows} · ${bytes}${errs}${eof}`
  })()

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-md bg-muted/30">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-background/50 px-3 py-2 text-xs text-muted-foreground">
        <span className="truncate">{statusLine}</span>
        <div className="flex items-center gap-2">
          {loading && <Loader2 className="size-3.5 animate-spin" />}
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={loading || state.done}
            onClick={() => fetchNext(cacheKey, state.bytesLoaded)}
          >
            Load more
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {error && (
          <div className="p-3">
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Failed to load NDJSON</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        )}
        {!error && state.rows.length === 0 && loading && (
          <div className="flex w-full flex-col gap-2 p-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        )}
        {!error && state.rows.length === 0 && !loading && state.done && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            File is empty.
          </div>
        )}
        {state.rows.length > 0 && (
          <Table className="text-xs">
            <TableHeader className="sticky top-0 bg-background/95 backdrop-blur">
              <TableRow>
                <TableHead className={`${ROW_NUMBER_WIDTH} text-muted-foreground`}>#</TableHead>
                {state.columns.map((col) => (
                  <TableHead key={col} className="font-mono">
                    {col}
                  </TableHead>
                ))}
                {state.columns.length === 0 && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.rows.map((row, idx) => (
                <TableRow key={idx} className={!row.ok ? 'bg-destructive/5' : undefined}>
                  <TableCell className={`${ROW_NUMBER_WIDTH} text-muted-foreground font-mono`}>
                    {idx + 1}
                  </TableCell>
                  {row.ok ? (
                    state.columns.map((col) => {
                      const text = renderCell(row.data[col])
                      const truncated =
                        text.length > CELL_PREVIEW_CHARS
                          ? `${text.slice(0, CELL_PREVIEW_CHARS)}…`
                          : text
                      return (
                        <TableCell
                          key={col}
                          className="font-mono align-top whitespace-pre-wrap break-words"
                          title={text.length > CELL_PREVIEW_CHARS ? text : undefined}
                        >
                          {truncated}
                        </TableCell>
                      )
                    })
                  ) : (
                    <TableCell
                      colSpan={Math.max(state.columns.length, 1)}
                      className="font-mono text-destructive"
                      title={row.raw}
                    >
                      <AlertCircle className="mr-1 inline size-3" />
                      parse error: {row.error}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}
