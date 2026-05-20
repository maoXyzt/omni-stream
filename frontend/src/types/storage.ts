export interface FileEntry {
  key: string
  size: number
  last_modified: string | null
  is_dir: boolean
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
  /// S3-specific identifying details. Set when `type === 's3'`. Excludes
  /// credentials — only fields a human would use to disambiguate one
  /// storage from another.
  s3?: {
    bucket: string
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
}
