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
): Promise<ListResult> {
  const params: Record<string, string> = {}
  if (prefix) params.prefix = prefix
  if (pageToken) params.page_token = pageToken
  if (storage) params.storage = storage
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

export function proxyUrl(key: string, storage?: string): string {
  const base = `/api/proxy/${encodeKey(key)}`
  if (!storage) return base
  return `${base}?storage=${encodeURIComponent(storage)}`
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
