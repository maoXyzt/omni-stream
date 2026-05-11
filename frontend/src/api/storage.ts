import { apiClient } from '@/api/client'
import type {
  FileMeta,
  ListResult,
  StoragesResponse,
} from '@/types/storage'

export async function listStorages(): Promise<StoragesResponse> {
  const { data } = await apiClient.get<StoragesResponse>('/api/storages')
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

// Path segments are encoded individually so that `/` separators stay literal
// (the backend route is `/api/proxy/{*key}` — a wildcard that wants raw slashes).
function encodeKey(key: string): string {
  return key
    .replace(/\/+$/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/')
}
