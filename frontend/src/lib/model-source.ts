import { proxyUrl } from '@/api/storage'
import { extensionOf } from '@/lib/path'
import { readPreviewBytes } from '@/lib/preview-bytes'
import { joinSidecarKey } from '@/lib/sidecar-path'

export const MAX_MODEL_BYTES = 32 * 1024 * 1024
const MAX_SIDECARS = 64

export interface ModelSource {
  bytes: ArrayBuffer
  sidecars: Map<string, ArrayBuffer>
}

export function gltfResourceUris(bytes: ArrayBuffer, binary: boolean): string[] {
  let jsonBytes = new Uint8Array(bytes)
  if (binary) {
    const view = new DataView(bytes)
    if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 ||
      view.getUint32(4, true) !== 2 || view.getUint32(12, true) > bytes.byteLength - 20 ||
      view.getUint32(16, true) !== 0x4e4f534a) {
      throw new Error('Invalid GLB header.')
    }
    jsonBytes = new Uint8Array(bytes, 20, view.getUint32(12, true))
  }
  const document = JSON.parse(new TextDecoder().decode(jsonBytes)) as Record<string, unknown>
  const uris = new Set<string>()
  for (const section of [document.buffers, document.images]) {
    if (!Array.isArray(section)) continue
    for (const entry of section) {
      if (entry && typeof entry === 'object' && typeof entry.uri === 'string' &&
        !/^data:/i.test(entry.uri)) {
        uris.add(entry.uri)
      }
    }
  }
  if (uris.size > MAX_SIDECARS) throw new Error('The model has too many external resources.')
  return [...uris]
}

/** All stored sidecars pass through Axios so private storages retain auth. */
export async function readModelSource(
  fileKey: string, src: string, storage: string | undefined, signal: AbortSignal,
): Promise<ModelSource> {
  const bytes = await readPreviewBytes({ fileKey, src, storage, signal, maxBytes: MAX_MODEL_BYTES })
  const sidecars = new Map<string, ArrayBuffer>()
  const extension = extensionOf(fileKey)
  if (extension === 'glb' || extension === 'gltf') {
    const uris = gltfResourceUris(bytes, extension === 'glb')
    // Validate every path before any sidecar request.
    const keys = new Set(uris.map((uri) => joinSidecarKey(fileKey, uri)))
    let remaining = MAX_MODEL_BYTES - bytes.byteLength
    for (const key of keys) {
      const data = await readPreviewBytes({
        fileKey: key, src: proxyUrl(key, storage), storage, signal, maxBytes: remaining,
      })
      sidecars.set(key, data)
      remaining -= data.byteLength
    }
  }
  return { bytes, sidecars }
}
