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
///   * .jsonl / .ndjson       → jsonl (added in a follow-up step)
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
    case null:
      throw new Error(`unsupported format for rows view: ${fileKey}`)
  }
}

export type SourceFormat = 'parquet'

export function detectFormat(fileKey: string): SourceFormat | null {
  const dot = fileKey.lastIndexOf('.')
  if (dot < 0) return null
  const ext = fileKey.slice(dot + 1).toLowerCase()
  if (ext === 'parquet' || ext === 'parq' || ext === 'pq') return 'parquet'
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
