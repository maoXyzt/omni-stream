import { apiClient } from '@/api/client'
import type {
  FileMeta,
  ListResult,
  ServerInfo,
  StoragesResponse,
} from '@/types/storage'

export async function listStorages(): Promise<StoragesResponse> {
  const { data } = await apiClient.get<StoragesResponse>('/api/storages')
  return data
}

export async function getServerInfo(): Promise<ServerInfo> {
  const { data } = await apiClient.get<ServerInfo>('/api/server')
  return data
}

export async function listFiles(
  prefix: string,
  pageToken?: string,
  storage?: string,
  /// 0 / omitted → one list call from `pageToken`. N > 0 → server walks N
  /// pages forward and returns the target page; intermediate `next_token`s
  /// come back in `walked_tokens` so the client cache fills in one round
  /// trip. Server caps the value; the backend constant is documented as 100.
  skipPages?: number,
): Promise<ListResult> {
  const params: Record<string, string> = {}
  if (prefix) params.prefix = prefix
  if (pageToken) params.page_token = pageToken
  if (storage) params.storage = storage
  if (skipPages && skipPages > 0) params.skip_pages = String(skipPages)
  const { data } = await apiClient.get<ListResult>('/api/list', { params })
  return data
}

export async function statFile(
  key: string,
  storage?: string,
): Promise<FileMeta> {
  const params: Record<string, string> = {}
  if (storage) params.storage = storage
  const { data } = await apiClient.get<FileMeta>(`/api/stat/${encodeKey(key)}`, {
    params,
  })
  return data
}

/// Direct-bytes URL for a stored file. The optional `version` flips the
/// URL into a cache-busting form when the caller knows the file's mtime —
/// typically `entry.last_modified` from the listing. The backend ignores
/// unknown query params, so this is purely a browser-cache key tweak; same
/// pattern as `thumbUrl`'s `?v=…`. Callers building stable shareable URLs
/// (copy-to-clipboard, "open in new tab") should omit `version`.
export function proxyUrl(
  key: string,
  storage?: string,
  version?: string | null,
): string {
  const params = new URLSearchParams()
  if (storage) params.set('storage', storage)
  if (version) params.set('v', version)
  const qs = params.toString()
  const base = `/api/proxy/${encodeKey(key)}`
  return qs ? `${base}?${qs}` : base
}

export interface ThumbOptions {
  storage?: string
  width?: number
  /// Passed as `v=…`; flips the backend to `Cache-Control: immutable`.
  /// Typically `FileEntry.last_modified` from the list response.
  version?: string | null
}

export function thumbUrl(key: string, opts: ThumbOptions = {}): string {
  const params = new URLSearchParams()
  if (opts.storage) params.set('storage', opts.storage)
  if (opts.width) params.set('w', String(opts.width))
  if (opts.version) params.set('v', opts.version)
  const qs = params.toString()
  const base = `/api/thumb/${encodeKey(key)}`
  return qs ? `${base}?${qs}` : base
}

// Path segments are encoded individually so that `/` separators stay literal
// (the backend route is `/api/proxy/{*key}` — a wildcard that wants raw slashes).
function encodeKey(key: string): string {
  return key
    .replace(/\/+$/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/')
}
