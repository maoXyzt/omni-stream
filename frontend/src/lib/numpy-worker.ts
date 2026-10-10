import { parseNpy, parseNpz, type ParsedNpz } from './npz'

self.onmessage = (event: MessageEvent<{ bytes: ArrayBuffer; fileKey: string; archive: boolean }>) => {
  try {
    const { bytes, fileKey, archive } = event.data
    const result: ParsedNpz = archive ? parseNpz(bytes) : {
      arrays: { [fileKey.split('/').pop() ?? 'array']: parseNpy(bytes) },
      compressedBytes: bytes.byteLength,
      extractedBytes: bytes.byteLength,
    }
    const transfers = new Set<ArrayBuffer>()
    for (const array of Object.values(result.arrays)) {
      if (array.data.buffer instanceof ArrayBuffer) transfers.add(array.data.buffer)
    }
    self.postMessage({ result }, { transfer: [...transfers] })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Unable to decode NumPy data.' })
  }
}
