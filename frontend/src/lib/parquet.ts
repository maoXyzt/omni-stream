import type {
  AsyncBuffer,
  FileMetaData,
  SchemaElement,
} from 'hyparquet'
import type { AxiosResponse } from 'axios'

import { apiClient } from '@/api/client'

// hyparquet is a pure-JS parquet reader. Loaded on demand so it only enters
// the bundle as a lazy chunk when the user opens a `.parquet` file — mirrors
// the `import()` pattern in `@/lib/highlight.ts` for hljs grammars.
let modPromise: Promise<typeof import('hyparquet')> | null = null
function loadHyparquet(): Promise<typeof import('hyparquet')> {
  if (!modPromise) modPromise = import('hyparquet')
  return modPromise
}

// hyparquet ships only SNAPPY built in; ZSTD / GZIP / BROTLI / LZ4 live in
// the sibling `hyparquet-compressors` package and have to be wired in via the
// `compressors` option. We load it lazily as part of the same parquet code
// path so users who never open a parquet file don't pay for the codecs.
let compressorsPromise: Promise<
  typeof import('hyparquet-compressors')
> | null = null
function loadCompressors(): Promise<typeof import('hyparquet-compressors')> {
  if (!compressorsPromise) compressorsPromise = import('hyparquet-compressors')
  return compressorsPromise
}

interface RangeFetchResult {
  buffer: ArrayBuffer
  totalBytes: number | null
}

const PARQUET_RANGE_TIMEOUT_MS = 120_000

async function fetchByteRange(
  src: string,
  start: number,
  endInclusive: number,
): Promise<RangeFetchResult> {
  let res: AxiosResponse<ArrayBuffer>
  try {
    res = await apiClient.get<ArrayBuffer>(src, {
      responseType: 'arraybuffer',
      timeout: PARQUET_RANGE_TIMEOUT_MS,
      headers: {
        Accept: 'application/octet-stream',
        Range: `bytes=${start}-${endInclusive}`,
      },
      transformResponse: [(value) => value],
    })
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(
        `parquet: byte-range read timed out after ${PARQUET_RANGE_TIMEOUT_MS / 1000}s. ` +
          'This file may contain very large cells or row groups that are expensive to fetch and decode.',
        { cause: err },
      )
    }
    throw err
  }
  const cr = res.headers['content-range'] as string | undefined
  let totalBytes: number | null = null
  if (cr) {
    const m = /\/(\d+)\s*$/.exec(cr)
    if (m) totalBytes = Number(m[1])
  } else {
    const len = res.headers['content-length']
    if (len) totalBytes = Number(len)
  }
  return { buffer: res.data, totalBytes }
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && /timeout|timed out/i.test(err.message)
}

// Probe with a single-byte Range so the server has to return the file size in
// `Content-Range: bytes 0-0/TOTAL`. Cheaper than a full HEAD round-trip and
// works through the same proxy code path real reads will use. hyparquet then
// uses byteLength to issue a tail Range for the footer (~512kb default).
async function discoverSize(src: string): Promise<number> {
  const { totalBytes } = await fetchByteRange(src, 0, 0)
  if (totalBytes === null) {
    throw new Error('parquet: server did not report file size in Content-Range')
  }
  return totalBytes
}

export async function createAsyncBuffer(src: string): Promise<AsyncBuffer> {
  const size = await discoverSize(src)
  return {
    byteLength: size,
    async slice(start: number, end?: number): Promise<ArrayBuffer> {
      const finalEnd = end ?? size
      // HTTP Range end is inclusive; AsyncBuffer end is exclusive.
      const { buffer } = await fetchByteRange(src, start, finalEnd - 1)
      return buffer
    },
  }
}

export interface ParquetSource {
  file: AsyncBuffer
  metadata: FileMetaData
}

export async function loadParquetSource(src: string): Promise<ParquetSource> {
  const [{ parquetMetadataAsync }, file] = await Promise.all([
    loadHyparquet(),
    createAsyncBuffer(src),
  ])
  const metadata = await parquetMetadataAsync(file)
  return { file, metadata }
}

export async function readParquetRows(opts: {
  file: AsyncBuffer
  metadata: FileMetaData
  rowStart: number
  rowEnd: number
}): Promise<Record<string, unknown>[]> {
  const [{ parquetReadObjects }, { compressors }] = await Promise.all([
    loadHyparquet(),
    loadCompressors(),
  ])
  return parquetReadObjects({
    file: opts.file,
    metadata: opts.metadata,
    rowStart: opts.rowStart,
    rowEnd: opts.rowEnd,
    compressors,
    // Without this, hyparquet must download every column chunk in any row
    // group that overlaps [rowStart, rowEnd) — for single-row-group files
    // (pandas/duckdb defaults) that's the whole file just to preview 100
    // rows. With the offset index, it fetches only the data pages that
    // actually contain the selected rows. Modern parquet writers (Spark,
    // Arrow ≥6, parquet-cpp, duckdb) emit offset indexes by default; older
    // files silently fall back to chunk-level reads.
    useOffsetIndex: true,
  })
}

export interface ParquetColumnInfo {
  name: string
  /// Fully resolved type signature: primitive name with logical refinements
  /// folded in (e.g. `STRING`, `TIMESTAMP(MICROS,UTC)`, `DECIMAL(18,2)`), or
  /// a composite signature for nested fields (`LIST<STRING>`, `MAP<STRING,
  /// INT32>`, `STRUCT<id: INT64, name: STRING>`). Surfaces the schema in a
  /// single column so the table stays readable.
  type: string
  repetition: string
}

// Walks the depth-first schema array parquet stores in its footer and yields
// one entry per top-level column. Composite types (LIST / MAP / STRUCT) are
// flattened into a single string signature rather than rendered as multiple
// indented rows — keeps the schema view scannable for the common shallow
// cases while still telling the user *what* a nested column actually holds.
export function extractTopLevelColumns(
  metadata: FileMetaData,
): ParquetColumnInfo[] {
  const schema = metadata.schema
  if (schema.length === 0) return []
  const out: ParquetColumnInfo[] = []
  let i = 1 // index 0 is the root group; its direct children are the columns
  while (i < schema.length) {
    const el = schema[i]
    const { display, advance } = describeType(schema, i)
    out.push({
      name: el.name,
      type: display,
      repetition: el.repetition_type ?? 'REQUIRED',
    })
    i += advance
  }
  return out
}

interface TypeDescription {
  display: string
  /// Number of schema elements consumed by this field (1 for primitives,
  /// 1 + descendants for groups). Returned so the caller can step forward
  /// without re-walking the subtree.
  advance: number
}

// Resolve a single schema node into a displayable type signature. Recursive:
// composite nodes (LIST/MAP/STRUCT) embed their children's signatures.
function describeType(schema: SchemaElement[], index: number): TypeDescription {
  const el = schema[index]
  const numChildren = el.num_children ?? 0
  if (numChildren === 0) {
    return { display: describePrimitive(el), advance: 1 }
  }

  const totalAdvance = 1 + countDescendants(schema, index)
  const tag = el.logical_type?.type ?? el.converted_type

  if (tag === 'LIST') {
    return { display: describeList(schema, index), advance: totalAdvance }
  }
  if (tag === 'MAP' || tag === 'MAP_KEY_VALUE') {
    return { display: describeMap(schema, index), advance: totalAdvance }
  }
  return { display: describeStruct(schema, index, numChildren), advance: totalAdvance }
}

// Parquet LIST has two layouts in the wild:
//   3-level (modern): group(LIST) > repeated group(list) > element
//   2-level (legacy): group(LIST) > repeated <element>
// Unwrap whichever applies and describe the element's type.
function describeList(schema: SchemaElement[], index: number): string {
  if (index + 1 >= schema.length) return 'LIST<?>'
  const inner = schema[index + 1]
  const innerChildren = inner.num_children ?? 0
  let elementIndex: number
  if (innerChildren >= 1) {
    elementIndex = index + 2
  } else {
    elementIndex = index + 1
  }
  if (elementIndex >= schema.length) return 'LIST<?>'
  return `LIST<${describeType(schema, elementIndex).display}>`
}

// Parquet MAP layout: group(MAP) > repeated group(key_value) > [key, value].
function describeMap(schema: SchemaElement[], index: number): string {
  if (index + 1 >= schema.length) return 'MAP<?,?>'
  const inner = schema[index + 1]
  if ((inner.num_children ?? 0) < 2) return 'MAP<?,?>'
  const keyIndex = index + 2
  if (keyIndex >= schema.length) return 'MAP<?,?>'
  const keyDesc = describeType(schema, keyIndex)
  const valueIndex = keyIndex + keyDesc.advance
  if (valueIndex >= schema.length) return `MAP<${keyDesc.display}, ?>`
  const valueDesc = describeType(schema, valueIndex)
  return `MAP<${keyDesc.display}, ${valueDesc.display}>`
}

// Anonymous group: walk children and render `STRUCT<field: TYPE, ...>`.
function describeStruct(
  schema: SchemaElement[],
  index: number,
  numChildren: number,
): string {
  const fields: string[] = []
  let cursor = index + 1
  let remaining = numChildren
  while (remaining > 0 && cursor < schema.length) {
    const child = schema[cursor]
    const childDesc = describeType(schema, cursor)
    fields.push(`${child.name}: ${childDesc.display}`)
    cursor += childDesc.advance
    remaining--
  }
  return `STRUCT<${fields.join(', ')}>`
}

// Fold the parquet logical/converted type into a single readable name.
// Falls back to the physical type when nothing more specific is annotated.
function describePrimitive(el: SchemaElement): string {
  const physical = el.type ?? 'UNKNOWN'
  const lt = el.logical_type
  if (lt) {
    switch (lt.type) {
      case 'STRING':
      case 'UUID':
      case 'DATE':
      case 'ENUM':
      case 'JSON':
      case 'BSON':
      case 'FLOAT16':
        return lt.type
      case 'TIME':
      case 'TIMESTAMP':
        return `${lt.type}(${lt.unit}${lt.isAdjustedToUTC ? ',UTC' : ''})`
      case 'DECIMAL':
        return `DECIMAL(${lt.precision},${lt.scale})`
      case 'INTEGER':
        return `${lt.isSigned ? 'INT' : 'UINT'}${lt.bitWidth}`
      default:
        return lt.type
    }
  }
  const ct = el.converted_type
  if (ct) {
    switch (ct) {
      case 'UTF8':
        return 'STRING'
      case 'DATE':
        return 'DATE'
      case 'TIME_MILLIS':
        return 'TIME(MILLIS)'
      case 'TIME_MICROS':
        return 'TIME(MICROS)'
      case 'TIMESTAMP_MILLIS':
        return 'TIMESTAMP(MILLIS)'
      case 'TIMESTAMP_MICROS':
        return 'TIMESTAMP(MICROS)'
      case 'DECIMAL':
        // Precision/scale live on the schema element itself for legacy DECIMAL.
        if (el.precision !== undefined) {
          return `DECIMAL(${el.precision},${el.scale ?? 0})`
        }
        return 'DECIMAL'
      case 'INT_8':
      case 'INT_16':
      case 'INT_32':
      case 'INT_64':
      case 'UINT_8':
      case 'UINT_16':
      case 'UINT_32':
      case 'UINT_64':
        return ct.replace('_', '')
      case 'ENUM':
      case 'JSON':
      case 'BSON':
        return ct
      default:
        return ct
    }
  }
  return physical
}

function countDescendants(schema: SchemaElement[], index: number): number {
  const numChildren = schema[index]?.num_children ?? 0
  if (!numChildren) return 0
  let cursor = index + 1
  let remaining = numChildren
  let count = 0
  while (remaining > 0 && cursor < schema.length) {
    count++
    const childChildren = countDescendants(schema, cursor)
    count += childChildren
    cursor += 1 + childChildren
    remaining--
  }
  return count
}

// Stringify a single cell value for inline table display. Primitives go
// straight through; composite types (STRUCT/LIST) render across multiple
// lines so a single struct cell reads like a small key/value list rather
// than one cramped JSON blob. The dialog/expanded view uses
// `formatCellExpanded` for the full pretty-printed JSON.
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Uint8Array) return `<binary ${value.byteLength}B>`
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return formatListInline(value)
  if (typeof value === 'object') {
    return formatStructInline(value as Record<string, unknown>)
  }
  return String(value)
}

// Pretty JSON for the cell-expand Dialog. Top-level primitives pass through;
// composites use JSON.stringify(…, 2) with bigint/Uint8Array/Date replacers
// so deep nested values stay legible too.
export function formatCellExpanded(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Uint8Array) return `<binary ${value.byteLength}B>`
  if (value instanceof Date) return value.toISOString()
  try {
    return JSON.stringify(value, jsonReplacer, 2)
  } catch {
    return String(value)
  }
}

function jsonReplacer(_key: string, v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Uint8Array) return `<binary ${v.byteLength}B>`
  if (v instanceof Date) return v.toISOString()
  return v
}

// One line per field: `field_name: value`. Nested composites collapse into a
// `{n fields}` / `[n]` summary so the cell stays scannable — the user can
// click to expand for the full JSON.
function formatStructInline(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj)
  if (entries.length === 0) return '{}'
  return entries.map(([k, v]) => `${k}: ${shallowFormat(v)}`).join('\n')
}

// Lists: render inline when small and all-primitive (`[1, 2, 3]`), otherwise
// one item per line with an `… (+N more)` tail so very large arrays don't
// stretch the row past the line-clamp.
function formatListInline(arr: unknown[]): string {
  if (arr.length === 0) return '[]'
  if (arr.length <= 8 && arr.every(isPrimitive)) {
    return `[${arr.map(shallowFormat).join(', ')}]`
  }
  const MAX = 4
  const shown = arr.slice(0, MAX).map((v, i) => `${i}: ${shallowFormat(v)}`)
  if (arr.length > MAX) shown.push(`… (+${arr.length - MAX} more)`)
  return shown.join('\n')
}

// One-level-deep formatter: used as the *value* part inside structs/lists.
// Strings get quoted to distinguish `"foo"` from a field name; deeper
// composites are summarised so we never emit multi-line content here.
function shallowFormat(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Uint8Array) return `<binary ${value.byteLength}B>`
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${value.length}]`
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    return keys.length === 0 ? '{}' : `{${keys.length} fields}`
  }
  return String(value)
}

function isPrimitive(v: unknown): boolean {
  return (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    typeof v === 'bigint'
  )
}

export function totalRowCount(metadata: FileMetaData): number {
  return Number(metadata.num_rows)
}

export function rowGroupCount(metadata: FileMetaData): number {
  return metadata.row_groups?.length ?? 0
}

// Reports the compression codec used across row groups. Most files use a
// single codec, so we return that; mixed-codec files (rare) surface as
// "mixed" rather than picking one arbitrarily.
export function compressionSummary(metadata: FileMetaData): string | null {
  const codecs = new Set<string>()
  for (const rg of metadata.row_groups ?? []) {
    for (const col of rg.columns ?? []) {
      const codec = col.meta_data?.codec
      if (codec) codecs.add(codec)
    }
  }
  if (codecs.size === 0) return null
  if (codecs.size === 1) return [...codecs][0]
  return 'mixed'
}
