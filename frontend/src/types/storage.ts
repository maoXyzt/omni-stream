export interface FileEntry {
  key: string
  size: number
  last_modified: string | null
  is_dir: boolean
  /** True when this entry is a filesystem symbolic link. Always false for
   *  non-local backends (S3). Orthogonal to is_dir: a symlink pointing at a
   *  directory has both set to true when follow_symlinks is enabled. */
  is_symlink: boolean
}

export interface ListResult {
  entries: FileEntry[]
  next_token: string | null
  /// Populated only when the request used `skip_pages > 0`. Each entry is
  /// the `next_token` of an intermediate walk step — i.e. `walked_tokens[i]`
  /// fetches the (i+1)-th page from the caller's starting point. Lets the
  /// client fill its page→token cache for every step in a single response.
  walked_tokens?: string[]
  /// Total page count when the backend can compute it cheaply. Present on
  /// local-fs listings (the directory scan already runs); omitted by S3
  /// (counting would require walking the full chain). The pager renders
  /// `Page X / Y` when present, `Page X` otherwise.
  total_pages?: number
}

export interface FileMeta {
  path: string
  size: number
  etag: string | null
  content_type: string | null
  last_modified: string | null
  is_dir: boolean
}

export interface ApiErrorBody {
  error?: string
  message?: string
  /** Actionable troubleshooting hint (present for ConvertFailed / QueryDiagnosed). */
  hint?: string
  /** Verbatim DuckDB error text (present for ConvertFailed only). */
  raw?: string
}

export interface StorageDescriptor {
  name: string
  type: 'local' | 's3'
  /// `false` for storages declared in the config that failed to initialise
  /// at server startup (e.g. local.root_path missing). The switcher renders
  /// these with an `[invalid]` tag and refuses selection; targeting one via
  /// `?storage=…` makes the API return 503 with the underlying reason.
  valid: boolean
  /// Init-failure message when `valid` is false. Displayed inside the
  /// storage card so operators know what to fix.
  error?: string | null
  /// Whether this storage accepts writes (create / edit / delete / rename).
  /// Mirrors the per-storage `writeable` server config. The SPA gates its
  /// write affordances on this; always false for invalid storages.
  writeable: boolean
  /// S3-specific identifying details. Set when `type === 's3'`. Excludes
  /// credentials — only fields a human would use to disambiguate one
  /// storage from another.
  ///
  /// `bucket` is `null` when the storage is in multi-bucket mode
  /// (`bucket` omitted or set to `"*"` in the server config): the root
  /// listing performs ListBuckets and each bucket appears as a top-level
  /// directory. The UI surfaces this as "(all buckets)".
  s3?: {
    bucket: string | null
    endpoint?: string | null
    region?: string | null
  } | null
  /// Local-fs identifying details. Set when `type === 'local'`.
  local?: {
    root_path: string
  } | null
}

export interface StoragesResponse {
  storages: StorageDescriptor[]
  default: string
}

export interface ServerInfo {
  hostname: string
  /// Backend semver from Cargo.toml; surfaced as a fixed bottom-left chip in
  /// the SPA so it's visible across pages without polling a separate
  /// endpoint.
  version: string
  /// Whether the server's bearer-token gate is on at all. Under a full
  /// lockdown /api/server sits behind the gate, so reading it implies the
  /// stored token was accepted; with public_read on it's readable without a
  /// token and just reports that writes need one.
  auth_enabled: boolean
  /// When the gate is on, whether reads are public and only writes need the
  /// token (true) or every request needs it (false). Drives whether the SPA
  /// prompts for a token lazily (on a write 401) or up front. Always true when
  /// auth_enabled is false.
  public_read: boolean
  /// Whether POST /api/query is live (server built with the duckdb feature,
  /// [sql] enabled, auth on). Gates the SQL editor entry points.
  sql_enabled: boolean
  /// Whether at least one storage is writeable. The SPA hides every write
  /// affordance (edit / new file / delete / rename) when false. Writes still
  /// require the bearer token at request time regardless of this flag.
  write_enabled: boolean
  /// Whether the DuckDB httpfs extension is available — prerequisite for SQL
  /// queries against S3 storages. null when sql_enabled is false (non-duckdb
  /// build or SQL gate off); true/false is the result of a real-time probe.
  /// SPA shows a warning when false and the active storage is S3.
  httpfs_ready: boolean | null
}

/** @deprecated Kept for reference; POST /api/convert now returns ConvertAccepted (202). */
export interface ConvertResult {
  /// Storage-relative path of the written Parquet file.
  output_key: string
  /// Number of rows written as reported by DuckDB.
  rows_written: number
  elapsed_ms: number
}

/** Immediate response from POST /api/convert (202 Accepted). */
export interface ConvertAccepted {
  job_id: string
}

/** Response from GET /api/convert/{job_id}. */
export interface ConvertStatus {
  job_id: string
  /** `"running"` | `"done"` | `"failed"` */
  state: 'running' | 'done' | 'failed'
  /** Wall-clock milliseconds elapsed (or total duration when terminal). */
  elapsed_ms: number
  // Present when state === 'done'
  output_key?: string
  rows_written?: number
  // Present when state === 'failed'
  summary?: string
  hint?: string
  raw?: string
}

export interface QueryColumn {
  name: string
  /// DuckDB logical type rendered as a string (e.g. "Int32", "Utf8").
  type: string
}

export interface QueryResult {
  columns: QueryColumn[]
  /// Row-major values. Numbers/booleans/strings come through natively;
  /// temporal & high-precision types arrive as display strings; SQL NULL is
  /// JSON null.
  rows: (string | number | boolean | null)[][]
  row_count: number
  /// True when the server dropped rows past its [sql].max_rows cap.
  truncated: boolean
  elapsed_ms: number
}
