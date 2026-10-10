import type { ParsedNpz } from './npz'

/** Transfer buffers instead of copying them, and stop decoding on navigation. */
export function decodeNumpy(
  bytes: ArrayBuffer, fileKey: string, signal: AbortSignal,
): Promise<ParsedNpz> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./numpy-worker.ts', import.meta.url), { type: 'module' })
    const cleanup = () => {
      worker.terminate()
      signal.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      reject(signal.reason ?? new DOMException('The NumPy decoder was cancelled.', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<{ result?: ParsedNpz; error?: string }>) => {
      cleanup()
      if (event.data.result) resolve(event.data.result)
      else reject(new Error(event.data.error ?? 'Unable to decode NumPy data.'))
    }
    worker.onerror = (event) => {
      cleanup()
      reject(new Error(event.message || 'Unable to start the NumPy decoder.'))
    }
    worker.postMessage({ bytes, fileKey, archive: /\.npz$/i.test(fileKey) }, [bytes])
  })
}
