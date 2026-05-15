// Rows View data source abstraction. The renderer / schema / selector
// pipeline only needs three things from the source: a column list (for the
// rules-editor "columns in this file" hint), a row count (for the page
// header), and a way to read a row range. Anything format-specific —
// parquet metadata, jsonl line offsets — stays behind this interface.

import {
  type ParquetSource,
  extractTopLevelColumns,
  loadParquetSource,
  readParquetRows,
  totalRowCount,
} from './parquet'

export interface ColumnInfo {
  /// Top-level column name. The first IDENT in a selector matches this.
  name: string
  /// Best-effort type signature. Parquet uses the schema metadata
  /// (`STRING`, `LIST<…>`, `STRUCT<…>` etc.); jsonl will use inferred JS
  /// types. Informational only — schema validation doesn't depend on it.
  type: string
}

export interface SourceDiagnostics {
  /// Number of input lines that didn't parse as a valid JSON object and
  /// were dropped from `numRows`. Surfaced in the UI when non-zero so a
  /// user with malformed data realises it instead of silently missing rows.
  /// Parquet doesn't drop lines, so its sources omit this field.
  skippedLines?: number
}

export interface ReadRowsResult {
  /// The actually-returned rows. May be shorter than `end - start` when the
  /// underlying source runs out of data (parquet near EOF, jsonl stream
  /// completing mid-page).
  rows: Record<string, unknown>[]
  /// True when more rows are available past the requested `rowEnd`. UI uses
  /// this for the "Load more" button visibility — single source of truth so
  /// the renderer doesn't have to reason about totalRows vs streaming.
  hasMore: boolean
  /// Most-recently-known total row count. Parquet knows this from the
  /// footer at load time and always reports it. Streaming jsonl reports
  /// null until the stream completes, then the final count. UI updates its
  /// state from each result so the header counter transitions naturally.
  totalRows: number | null
  /// Optional updated diagnostics. Streaming sources surface counts that
  /// grow as more lines are read; whole-file sources only set this on the
  /// first read.
  diagnostics?: SourceDiagnostics
}

export interface RowsSource {
  kind: 'parquet' | 'jsonl'
  columns: ColumnInfo[]
  /// Best-known row count at source-load time. Parquet's metadata gives the
  /// exact number; jsonl whole-file load knows it after parsing; jsonl
  /// streaming starts at null. UI uses this for the initial render before
  /// the first readRows result lands, then updates from result.totalRows.
  totalRows: number | null
  /// Initial diagnostics from load-time work (e.g. column-inference parse
  /// pass). May be superseded by later readRows results in streaming sources.
  diagnostics?: SourceDiagnostics
  /// Read a contiguous row range. Implementations may cache aggressively
  /// (jsonl whole-file) or stream on demand (jsonl streaming); the contract
  /// is the same.
  readRows(rowStart: number, rowEnd: number): Promise<ReadRowsResult>
}

/// Load a rows-view-ready source. Dispatches by file extension.
///   * .parquet / .parq / .pq → parquet, via hyparquet
///   * .jsonl / .ndjson       → jsonl, full-file load with line parsing
///   * anything else          → throw, the route shouldn't be reachable for
///                              non-supported extensions
export async function loadRowsSource(
  src: string,
  fileKey: string,
): Promise<RowsSource> {
  const fmt = detectFormat(fileKey)
  switch (fmt) {
    case 'parquet':
      return loadParquetRowsSource(src)
    case 'jsonl':
      return loadJsonlRowsSource(src)
    case null:
      throw new Error(`unsupported format for rows view: ${fileKey}`)
  }
}

export type SourceFormat = 'parquet' | 'jsonl'

export function detectFormat(fileKey: string): SourceFormat | null {
  const dot = fileKey.lastIndexOf('.')
  if (dot < 0) return null
  const ext = fileKey.slice(dot + 1).toLowerCase()
  if (ext === 'parquet' || ext === 'parq' || ext === 'pq') return 'parquet'
  if (ext === 'jsonl' || ext === 'ndjson') return 'jsonl'
  return null
}

// -----------------------------------------------------------------------
// Parquet impl
// -----------------------------------------------------------------------

async function loadParquetRowsSource(src: string): Promise<RowsSource> {
  const parquet: ParquetSource = await loadParquetSource(src)
  const cols = extractTopLevelColumns(parquet.metadata)
  const total = totalRowCount(parquet.metadata)
  return {
    kind: 'parquet',
    columns: cols.map((c) => ({ name: c.name, type: c.type })),
    totalRows: total,
    readRows: async (rowStart, rowEnd) => {
      // hyparquet expects valid bounds; clamp the upper end so a caller
      // asking for [N-10, N+10) doesn't trip an internal assert.
      const clampedEnd = Math.min(rowEnd, total)
      const rows =
        clampedEnd <= rowStart
          ? []
          : await readParquetRows({
              file: parquet.file,
              metadata: parquet.metadata,
              rowStart,
              rowEnd: clampedEnd,
            })
      return {
        rows,
        hasMore: clampedEnd < total,
        totalRows: total,
      }
    },
  }
}

// -----------------------------------------------------------------------
// JSONL impl — incremental streaming
// -----------------------------------------------------------------------

/// How many rows we read up-front during source load. Sized to give the
/// column-inference sampler enough breadth without blocking on full
/// downloads of huge files.
const JSONL_COLUMN_PROBE_ROWS = 100

/// Streaming jsonl loader. Opens the response body as a ReadableStream,
/// reads + parses chunks on demand. Memory cost grows with the rows the
/// user actually pages through, not with file size — so a 5 GB jsonl
/// opens in a few hundred ms (column probe only) and the user can keep
/// hitting "Load more" as long as their tab can hold the accumulated rows.
async function loadJsonlRowsSource(src: string): Promise<RowsSource> {
  const res = await fetch(src)
  if (!res.ok) {
    throw new Error(
      `failed to fetch JSONL: ${res.status} ${res.statusText || ''}`.trim(),
    )
  }
  if (!res.body) {
    throw new Error('jsonl: response has no streaming body')
  }
  const stream = new JsonlStream(res.body)
  await stream.ensureRowCount(JSONL_COLUMN_PROBE_ROWS)
  const columns = inferJsonlColumns(stream.rows, 100)
  return {
    kind: 'jsonl',
    columns,
    totalRows: stream.done ? stream.rows.length : null,
    diagnostics: snapshotDiagnostics(stream),
    readRows: async (rowStart, rowEnd) => {
      await stream.ensureRowCount(rowEnd)
      const clampedEnd = Math.min(rowEnd, stream.rows.length)
      return {
        rows: stream.rows.slice(rowStart, clampedEnd),
        // More rows available iff the stream isn't finished, OR we still
        // have buffered rows past the requested end.
        hasMore: !stream.done || clampedEnd < stream.rows.length,
        totalRows: stream.done ? stream.rows.length : null,
        diagnostics: snapshotDiagnostics(stream),
      }
    },
  }
}

function snapshotDiagnostics(s: JsonlStream): SourceDiagnostics | undefined {
  return s.errors > 0 ? { skippedLines: s.errors } : undefined
}

/// Pull JSONL records out of a ReadableStream one chunk at a time. Exposed
/// so its line-buffer + parsing behavior can be unit-tested without spinning
/// up a real Response.
///
/// The `ensureRowCount(n)` contract: after the promise resolves, either
/// `rows.length >= n` or `done` is true (stream exhausted). Repeated calls
/// chain so concurrent readers don't race on the underlying reader.
export class JsonlStream {
  readonly rows: Record<string, unknown>[] = []
  errors = 0
  done = false
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder('utf-8')
  private buffer = ''
  private bomStripped = false
  // Serializes ensureRowCount calls so two concurrent readers can't race
  // on the same `reader.read()` queue and interleave chunk processing.
  private pending: Promise<void> = Promise.resolve()

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader()
  }

  async ensureRowCount(target: number): Promise<void> {
    if (this.done || this.rows.length >= target) return
    this.pending = this.pending.then(() => this.driveTo(target))
    return this.pending
  }

  private async driveTo(target: number): Promise<void> {
    while (!this.done && this.rows.length < target) {
      const { value, done } = await this.reader.read()
      if (done) {
        this.done = true
        // Flush whatever's left in the buffer (final line without newline)
        // plus any trailing bytes the decoder is holding from a chunked
        // multi-byte char.
        const tail = this.decoder.decode()
        if (tail.length > 0) this.buffer += tail
        if (this.buffer.length > 0) {
          this.processLine(this.buffer)
          this.buffer = ''
        }
        return
      }
      let text = this.decoder.decode(value, { stream: true })
      // Strip BOM once, on the very first chunk after decoding.
      if (!this.bomStripped) {
        this.bomStripped = true
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      }
      this.buffer += text
      // Drain every newline-terminated record currently in the buffer.
      // CRLF endings are tolerated because processLine trims first.
      let nl = this.buffer.indexOf('\n')
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl)
        this.buffer = this.buffer.slice(nl + 1)
        this.processLine(line)
        nl = this.buffer.indexOf('\n')
      }
    }
  }

  private processLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    try {
      const parsed = JSON.parse(trimmed)
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        this.rows.push(parsed as Record<string, unknown>)
        return
      }
    } catch {
      // fall through to the error counter
    }
    this.errors++
  }
}

export interface ParseJsonlResult {
  /// Successfully-parsed records. Lines that didn't decode to a plain
  /// object are skipped — callers don't see them, but their count is
  /// available in `errors`.
  rows: Record<string, unknown>[]
  /// Number of non-blank lines that failed to parse, or parsed to a value
  /// that wasn't an object (number / array / null at top level).
  errors: number
}

/// Split JSONL text into records. Pure function so it's easy to unit test.
/// Tolerant by design:
///   * blank / whitespace-only lines skipped (don't count as errors)
///   * malformed JSON skipped (counted as error)
///   * top-level non-object JSON (number, string, array) skipped (counted)
///   * last line without trailing newline still read
export function parseJsonlText(text: string): ParseJsonlResult {
  const rows: Record<string, unknown>[] = []
  let errors = 0
  // Strip BOM if present — some tools (PowerShell redirects, Excel exports)
  // start the file with U+FEFF and JSON.parse rejects it.
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (const raw of cleaned.split('\n')) {
    // Trailing \r from CRLF endings is the only common in-line whitespace
    // that matters; .trim() handles it along with leading spaces.
    const line = raw.trim()
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      errors++
      continue
    }
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      rows.push(parsed as Record<string, unknown>)
    } else {
      errors++
    }
  }
  return { rows, errors }
}

/// Infer per-column types from the first `sampleSize` rows. Field order
/// follows first-occurrence across the sample — JSON objects preserve
/// insertion order in JS engines, which mirrors what the user wrote.
export function inferJsonlColumns(
  rows: Record<string, unknown>[],
  sampleSize: number,
): ColumnInfo[] {
  const order: string[] = []
  const seen = new Set<string>()
  const types = new Map<string, Set<string>>()
  const limit = Math.min(rows.length, sampleSize)
  for (let i = 0; i < limit; i++) {
    const row = rows[i]!
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k)
        order.push(k)
      }
      const set = types.get(k) ?? new Set<string>()
      set.add(jsonTypeName(row[k]))
      types.set(k, set)
    }
  }
  return order.map((name) => ({
    name,
    type: [...(types.get(name) ?? new Set<string>())].sort().join(' | ') || 'unknown',
  }))
}

function jsonTypeName(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return 'STRING'
  if (typeof v === 'boolean') return 'BOOL'
  if (typeof v === 'number') return Number.isInteger(v) ? 'INT' : 'FLOAT'
  if (Array.isArray(v)) return 'LIST'
  if (typeof v === 'object') return 'STRUCT'
  return typeof v
}
