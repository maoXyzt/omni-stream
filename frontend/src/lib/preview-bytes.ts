import { apiClient } from '@/api/client'
import { statFile } from '@/api/storage'

interface PreviewBytesRequest {
  fileKey: string
  src: string
  storage?: string
  maxBytes: number
  signal: AbortSignal
}

/** Only bounded, small files may be materialized for binary parsers. */
export async function readPreviewBytes({
  fileKey, src, storage, maxBytes, signal,
}: PreviewBytesRequest): Promise<ArrayBuffer> {
  signal.throwIfAborted()
  const { size } = await statFile(fileKey, storage)
  signal.throwIfAborted()
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) {
    throw new Error(
      'This preview requires a non-empty file within the remaining ' +
      (maxBytes / 1024 / 1024).toFixed(1) + ' MiB preview limit.',
    )
  }
  // Axios' fetch adapter preserves the shared bearer interceptor, and gives us
  // a cancellable browser stream. Allocate once; never buffer an unbounded body.
  const response = await apiClient.get<ReadableStream<Uint8Array>>(src, {
    adapter: 'fetch',
    responseType: 'stream',
    maxContentLength: size,
    signal,
  })
  const reader = response.data.getReader()
  const bytes = new Uint8Array(size)
  let offset = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      if (offset + value.byteLength > size) {
        throw new Error('The file changed size while loading. Reopen the preview.')
      }
      bytes.set(value, offset)
      offset += value.byteLength
    }
    if (offset !== size) throw new Error('The preview download is incomplete. Please retry.')
    return bytes.buffer
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
