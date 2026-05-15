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

export interface RowsSource {
  kind: 'parquet' | 'jsonl'
  columns: ColumnInfo[]
  numRows: number
  /// Read a contiguous row range. Implementations may cache aggressively
  /// (jsonl loads the whole file upfront); the contract is the same.
  readRows(rowStart: number, rowEnd: number): Promise<Record<string, unknown>[]>
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
  return {
    kind: 'parquet',
    columns: cols.map((c) => ({ name: c.name, type: c.type })),
    numRows: totalRowCount(parquet.metadata),
    readRows: (rowStart, rowEnd) =>
      readParquetRows({
        file: parquet.file,
        metadata: parquet.metadata,
        rowStart,
        rowEnd,
      }),
  }
}

// -----------------------------------------------------------------------
// JSONL impl
// -----------------------------------------------------------------------

/// v1 strategy: download the whole file, parse line by line. Memory cost
/// ≈ file size + parsed objects. Acceptable for typical datasets; large
/// (>50 MB) files would warrant Range-based streaming — left as future work.
async function loadJsonlRowsSource(src: string): Promise<RowsSource> {
  const res = await fetch(src)
  if (!res.ok) {
    throw new Error(
      `failed to fetch JSONL: ${res.status} ${res.statusText || ''}`.trim(),
    )
  }
  const text = await res.text()
  const { rows } = parseJsonlText(text)
  const columns = inferJsonlColumns(rows, 100)
  return {
    kind: 'jsonl',
    columns,
    numRows: rows.length,
    readRows: async (rowStart, rowEnd) => rows.slice(rowStart, rowEnd),
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
