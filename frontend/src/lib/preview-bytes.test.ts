import { beforeEach, describe, expect, it, vi } from 'vitest'

import { apiClient } from '@/api/client'
import { statFile } from '@/api/storage'
import { readPreviewBytes } from './preview-bytes'

vi.mock('@/api/client', () => ({ apiClient: { get: vi.fn() } }))
vi.mock('@/api/storage', () => ({ statFile: vi.fn() }))

const request = () => ({
  fileKey: 'points.npy', src: '/api/proxy/points.npy', storage: 'private',
  maxBytes: 8, signal: new AbortController().signal,
})

function serve(size: number, chunks: number[][]) {
  vi.mocked(statFile).mockResolvedValue({
    path: 'points.npy', size, is_dir: false, etag: null,
    content_type: null, last_modified: null,
  })
  vi.mocked(apiClient.get).mockResolvedValue({
    data: new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(Uint8Array.from(chunk)))
        controller.close()
      },
    }),
  })
}

beforeEach(() => vi.clearAllMocks())

describe('bounded preview reads', () => {
  it('rejects a large file before reading its body', async () => {
    serve(9, [])
    await expect(readPreviewBytes(request())).rejects.toThrow('preview limit')
    expect(apiClient.get).not.toHaveBeenCalled()
  })

  it('reads multiple chunks through the authenticated stream adapter', async () => {
    serve(4, [[1, 2], [3, 4]])
    expect(new Uint8Array(await readPreviewBytes(request()))).toEqual(Uint8Array.of(1, 2, 3, 4))
    expect(apiClient.get).toHaveBeenCalledWith('/api/proxy/points.npy', expect.objectContaining({
      adapter: 'fetch', responseType: 'stream', maxContentLength: 4,
    }))
    expect(statFile).toHaveBeenCalledWith('points.npy', 'private')
  })

  it('rejects growth and truncation instead of accepting corrupt input', async () => {
    serve(2, [[1, 2, 3]])
    await expect(readPreviewBytes(request())).rejects.toThrow('changed size')
    serve(4, [[1, 2, 3]])
    await expect(readPreviewBytes(request())).rejects.toThrow('incomplete')
  })

  it('stops before fetching after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(readPreviewBytes({ ...request(), signal: controller.signal })).rejects.toThrow()
    expect(statFile).not.toHaveBeenCalled()
  })
})
