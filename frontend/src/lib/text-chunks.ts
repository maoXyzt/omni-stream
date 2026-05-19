// Range-based chunked text reader. Shared between the full-screen text
// preview and the Rows view `text` widget so both partial-load using the
// same semantics: a first request fetches up to `CHUNK_BYTES`, subsequent
// requests advance one chunk at a time, EOF is detected via
// `Content-Range`.
//
// Format: `bytes 0-262143/1500000` or `bytes 0-262143/*`.

import { apiClient, ApiError } from '@/api/client'

/// First-chunk size and the threshold above which chunked loading kicks
/// in. A file at or below this size fits in one fetch (server returns
/// `isFull: true`); a larger file streams in `CHUNK_BYTES` slices.
export const CHUNK_BYTES = 1024 * 1024

export interface LoadState {
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

export const INITIAL_STATE: LoadState = {
  text: '',
  bytesLoaded: 0,
  totalBytes: null,
  done: false,
}

export interface RangeFetchResult {
  body: string
  endByte: number
  totalBytes: number | null
  isFull: boolean
}

export function parseContentRange(
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

export async function fetchRange(
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

export function mergeChunk(prev: LoadState, fetched: RangeFetchResult): LoadState {
  return {
    text: prev.text + fetched.body,
    bytesLoaded: fetched.endByte + 1,
    totalBytes: fetched.totalBytes ?? prev.totalBytes,
    done: fetched.isFull,
  }
}

export function describeFetchError(err: unknown): string {
  if (err instanceof ApiError) return `${err.status} — ${err.message}`
  if (err instanceof Error) return err.message
  return 'fetch failed'
}

export function formatBytes(n: number | null): string {
  if (n === null) return '?'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GiB`
}

export function splitLines(text: string): string[] {
  if (!text) return []
  // Strip a single trailing newline so a file ending in `\n` doesn't render a
  // phantom empty last row. Multiple trailing newlines still produce blank
  // rows on purpose.
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  return trimmed.split('\n')
}
