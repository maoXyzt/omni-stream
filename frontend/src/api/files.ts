import { apiClient } from '@/api/client'
import { encodeKey } from '@/lib/path'
import type { FileMeta } from '@/types/storage'

/// Create or overwrite a text/code file. `overwrite = false` (new file) makes
/// the server return 409 if the key already exists; `true` (saving an edit)
/// replaces it. The body is sent as raw text — `transformRequest` overrides
/// axios's default JSON serialization so the string isn't quoted/escaped, and
/// no `Content-Type` is sent so the server infers it from the file extension
/// (correct `application/json` / `text/html` / … on S3, where the type is
/// stored). Bearer auth is injected by the shared client interceptor; a 401
/// clears the stored token so the caller can prompt for re-entry and retry.
export async function putFile(
  storage: string,
  key: string,
  content: string,
  overwrite: boolean,
): Promise<FileMeta> {
  const { data } = await apiClient.put<FileMeta>(
    `/api/files/${encodeKey(key)}`,
    content,
    {
      params: { storage, overwrite },
      transformRequest: [(v) => v],
    },
  )
  return data
}

/// Delete a file. Resolves on the server's 204; rejects with `ApiError` on
/// 401 / 403 / 404 / 5xx.
export async function deleteFile(storage: string, key: string): Promise<void> {
  await apiClient.delete(`/api/files/${encodeKey(key)}`, { params: { storage } })
}

/// Rename / move a file. `from` and `to` are storage-relative keys (in
/// multi-bucket S3 mode they include the leading `<bucket>/`). `overwrite =
/// false` makes the server return 409 when `to` already exists.
export async function moveFile(
  storage: string,
  from: string,
  to: string,
  overwrite: boolean,
): Promise<FileMeta> {
  const { data } = await apiClient.post<FileMeta>('/api/move', {
    storage,
    from,
    to,
    overwrite,
  })
  return data
}
