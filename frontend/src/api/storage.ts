import { apiClient } from '@/api/client'
import type { FileMeta, ListResult } from '@/types/storage'

export async function listFiles(
  prefix: string,
  pageToken?: string,
): Promise<ListResult> {
  const params: Record<string, string> = {}
  if (prefix) params.prefix = prefix
  if (pageToken) params.page_token = pageToken
  const { data } = await apiClient.get<ListResult>('/api/list', { params })
  return data
}

export async function statFile(key: string): Promise<FileMeta> {
  const { data } = await apiClient.get<FileMeta>(`/api/stat/${encodeKey(key)}`)
  return data
}

export function proxyUrl(key: string): string {
  return `/api/proxy/${encodeKey(key)}`
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
