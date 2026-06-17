import { apiClient } from '@/api/client'
import { encodeKey } from '@/lib/path'
import type { FileMeta } from '@/types/storage'

/// Create or overwrite a file. `content` may be a plain string (text/code
/// editor) or a `Blob` (binary upload). `overwrite = false` makes the server
/// return 409 if the key already exists. The body is sent raw —
/// `transformRequest` overrides axios's default JSON serialization, and no
/// explicit `Content-Type` is set so the server infers it from the file
/// extension. Bearer auth is injected by the shared client interceptor; a 401
/// clears the stored token so the caller can prompt for re-entry and retry.
/// `onProgress` is called with 0–100 as bytes are sent (upload streams only;
/// not invoked for string content where the entire payload is known upfront
/// and small).
export async function putFile(
  storage: string,
  key: string,
  content: string | Blob,
  overwrite: boolean,
  onProgress?: (pct: number) => void,
): Promise<FileMeta> {
  const { data } = await apiClient.put<FileMeta>(
    `/api/files/${encodeKey(key)}`,
    content,
    {
      params: { storage, overwrite },
      transformRequest: [(v) => v],
      onUploadProgress: onProgress
        ? (e) => {
            const pct =
              e.total && e.total > 0
                ? Math.round((e.loaded / e.total) * 100)
                : 0
            onProgress(pct)
          }
        : undefined,
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
